import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Attachment, ChatItem, ChatMeta } from '@zumibot/shared/types'
import type { SideQuestion } from '@zumibot/shared/btw'
import type { TodoFile, TodoItem } from '@zumibot/shared/todos'
import { forkChat, type ForkDeps } from '../../src/core/chat/fork'
import type { StoredSide } from '../../src/core/btw/sideQuestions'
import { AttachmentStore } from '../../src/core/attachments/attachmentStore'
import { SnapshotStore } from '../../src/core/files/snapshotStore'
import { ChatStore } from '../../src/core/store/chatStore'

let tmp: string
let store: ChatStore
let files: AttachmentStore
let snaps: SnapshotStore
let deps: ForkDeps
let n: number

beforeEach(async () => {
  tmp = await fs.mkdtemp(join(tmpdir(), 'fork-'))
  n = 0
  store = new ChatStore(
    join(tmp, 'data'),
    () => 1000,
    () => `c${++n}`
  )
  let f = 0
  files = new AttachmentStore(join(tmp, 'attachments'), () => `f${++f}`)
  snaps = new SnapshotStore(join(tmp, 'snaps'))
  deps = { store, files, snapshots: snaps, now: () => 5000 }
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

const user = (id: string, extra: Partial<Extract<ChatItem, { type: 'user' }>> = {}): ChatItem => ({
  type: 'user',
  id,
  text: `text ${id}`,
  ts: 1,
  ...extra
})
const asst = (id: string, extra: Record<string, unknown> = {}): ChatItem =>
  ({ type: 'assistant', id, text: `reply ${id}`, ts: 2, ...extra }) as ChatItem
const ids = (items: ChatItem[]) => items.map((i) => i.id)

async function seedSingle(items: ChatItem[], over: Partial<ChatMeta> = {}): Promise<ChatMeta> {
  const c = await store.create('helper', '/work')
  await store.saveItems(c.id, items)
  return store.update(c.id, { title: 'Plan', sessionId: 's9', ...over })
}

const single = (): ChatItem[] => [
  user('u1'),
  asst('a1', { cut: { session: 's1', at: 'x1' }, end: { session: 's1', at: 'x1' } }),
  user('u2'),
  asst('a2', { cut: { session: 's1', at: 'x2' }, end: { session: 's1', at: 'x2' } })
]

const todo = (id: string, from: string | null, over: Partial<TodoItem> = {}): TodoItem => ({
  id,
  text: `todo ${id}`,
  group: null,
  from: { chatId: null, turn: 't', itemId: from, label: 'Reply', at: 1 },
  addedBy: 'helper',
  done: null,
  removed: null,
  last: { action: 'added', by: 'helper', at: 1 },
  rev: 1,
  updatedAt: 1,
  ...over
})

describe('forkChat', () => {
  it("a fork of a Codex chat takes its session engine from the stamp, a Claude chat's fork has none", async () => {
    // As a Codex turn writes them: no cut stamp on a reply, the turn's end (thread, turn id, engine) on its last item.
    const codexTurns: ChatItem[] = [
      user('u1'),
      asst('m1'), // a reply mid-turn: no stamp at all
      asst('a1', { end: { session: 's1', at: 'x1', engine: 'codex' } }),
      user('u2'),
      asst('a2', { end: { session: 's1', at: 'x2', engine: 'codex' } })
    ]
    const cx = await seedSingle(codexTurns, { sessionEngine: 'codex' })
    const fromUser = await forkChat(deps, cx.id, 'u2')
    expect(fromUser.chat).toMatchObject({ sessionId: 's1', next: { at: 'x1' }, sessionEngine: 'codex' })
    // A reply that ends its turn forks the thread at that turn, rather than reseeding.
    const fromReply = await forkChat(deps, cx.id, 'a1')
    expect(fromReply.chat).toMatchObject({ sessionId: 's1', next: { at: 'x1' }, sessionEngine: 'codex' })
    const fromLast = await forkChat(deps, cx.id, 'a2')
    expect(fromLast.chat).toMatchObject({ sessionId: 's1', next: { at: 'x2' }, sessionEngine: 'codex' })
    // One mid-turn has no turn to fork at: it reseeds, with no engine mark.
    const midTurn = await forkChat(deps, cx.id, 'm1')
    expect(midTurn.chat).toMatchObject({ sessionId: null, next: { seed: true } })
    expect(midTurn.chat).not.toHaveProperty('sessionEngine')
    const cl = await seedSingle(single())
    const plain = await forkChat(deps, cl.id, 'u2')
    expect(plain.chat.sessionId).toBe('s1')
    expect(plain.chat).not.toHaveProperty('sessionEngine')
  })

  it('fork copies no to-dos: they live once on the board, under the chat they were made in', async () => {
    const src = await seedSingle(single())
    const card = todo('t1', 'a1', { from: { chatId: src.id, turn: 't', itemId: 'a1', label: 'Reply', at: 1 } })
    await store.updateBoard(() => ({ v: 1, rev: 1, seen: {}, items: [card] }))
    const r = await forkChat(deps, src.id, 'a1')
    expect((await store.loadBoard()).items.map((i) => [i.id, i.from.chatId])).toEqual([['t1', src.id]])
    expect(r.chat.id).not.toBe(src.id)
  })

  it('fork copies finished side questions anchored in the copied items', async () => {
    const src = await seedSingle(single())
    const side = (id: string, after: string | null, state: SideQuestion['state'] = 'done'): SideQuestion => ({
      id,
      after,
      state,
      question: id,
      agent: 'helper',
      askedAt: 10,
      answer: 'answer',
      ...(state === 'done' || state === 'error' || state === 'stopped' ? { endedAt: 20 } : {})
    })
    const entries = [
      side('copied', 'a1'),
      side('later', 'a2'),
      side('before', null, 'error'),
      side('running', 'u1', 'running'),
      side('picking', null, 'picking'),
      side('stopped', 'u1', 'stopped')
    ]
    await store.saveSide(src.id, entries)

    const r = await forkChat(deps, src.id, 'a1')

    expect(await store.loadSide(r.chat.id)).toEqual([entries[0], entries[2], entries[5]])
    expect(ids(await store.loadItems(r.chat.id))).toEqual(['u1', 'a1'])
    expect(await store.loadSide(src.id)).toEqual(entries)
  })

  it("fork keeps a thread's follow-ups and the root snapshot", async () => {
    const src = await seedSingle(single())
    const root: StoredSide = {
      id: 'root',
      question: 'Q1',
      agent: 'helper',
      askedAt: 10,
      after: 'a1',
      state: 'done',
      answer: 'A1',
      endedAt: 20,
      snapshot: { point: { session: 's1', at: 'x1' }, upTo: 'a1', context: 'Room lines' }
    }
    const next: SideQuestion = {
      id: 'next',
      question: 'Q2',
      agent: 'helper',
      thread: 'root',
      askedAt: 30,
      after: 'a1',
      state: 'done',
      answer: 'A2',
      endedAt: 40
    }
    await store.saveSide(src.id, [root, next])
    const r = await forkChat(deps, src.id, 'a1')
    expect(await store.loadSide(r.chat.id)).toEqual([root, next])
  })

  it('fork at an agent message copies up to it and cuts at its uuid', async () => {
    const src = await seedSingle(single(), { reactions: { a1: ['👍'], a2: ['🎉'] } })
    const r = await forkChat(deps, src.id, 'a1')
    expect(r.draft).toBeNull()
    expect(r.chat).toMatchObject({ agentName: 'helper', cwd: '/work', sessionId: 's1', next: { at: 'x1' } })
    expect(r.chat.id).not.toBe(src.id)
    expect(ids(await store.loadItems(r.chat.id))).toEqual(['u1', 'a1'])
    expect((await store.get(r.chat.id))?.reactions).toEqual({ a1: ['👍'] })
  })

  it("a fork keeps the chat's model, since the cut session's cache is on it", async () => {
    const src = await seedSingle(single(), { model: 'sonnet' })
    const r = await forkChat(deps, src.id, 'a1')
    expect((await store.get(r.chat.id))?.model).toBe('sonnet')
  })

  it('a fork keeps a model picked by hand as picked by hand, so commands still leave it alone', async () => {
    const src = await seedSingle(single(), { model: 'haiku', modelByHand: true })
    const r = await forkChat(deps, src.id, 'a1')
    expect(await store.get(r.chat.id)).toMatchObject({ model: 'haiku', modelByHand: true })
    const plain = await forkChat(deps, (await seedSingle(single(), { model: 'sonnet' })).id, 'a1')
    expect((await store.get(plain.chat.id))?.modelByHand).toBeUndefined()
  })

  it("a fork keeps the chat's mode and effort", async () => {
    const src = await seedSingle(single(), { permissionMode: 'plan', effort: 'xhigh' })
    const r = await forkChat(deps, src.id, 'a1')
    expect(await store.get(r.chat.id)).toMatchObject({ permissionMode: 'plan', effort: 'xhigh' })
    const plain = await forkChat(deps, (await seedSingle(single())).id, 'a1')
    const meta = await store.get(plain.chat.id)
    expect([meta?.permissionMode, meta?.effort]).toEqual([undefined, undefined])
  })

  it('fork at an agent message without a cut seeds a fresh session', async () => {
    const src = await seedSingle([user('u1'), asst('a1')])
    const r = await forkChat(deps, src.id, 'a1')
    expect(r.chat).toMatchObject({ sessionId: null, next: { seed: true } })
  })

  it('fork at a user message copies before it and returns its text and staged attachments as the draft', async () => {
    const staged = await files.stageBytes('note.txt', Buffer.from('hello'))
    if (!staged.ok) throw new Error(staged.error)
    const src = await store.create('helper', '/work')
    const [att] = await files.commit(src.id, [staged.attachment.id])
    await store.saveItems(src.id, [...single().slice(0, 2), user('u2', { attachments: [att] }), asst('a2')])
    const r = await forkChat(deps, src.id, 'u2')
    expect(ids(await store.loadItems(r.chat.id))).toEqual(['u1', 'a1'])
    expect(r.chat).toMatchObject({ sessionId: 's1', next: { at: 'x1' } })
    expect(r.draft?.text).toBe('text u2')
    expect(r.draft?.attachments).toHaveLength(1)
    const staged2 = r.draft!.attachments[0]
    expect(staged2.id).not.toBe(att.id)
    expect(await files.stagedFile(staged2.id)).not.toBeNull()
    // the sent file is still there for the source chat
    expect(await fs.readFile(files.pathOf(src.id, att), 'utf8')).toBe('hello')
  })

  it('fork at the first user message gives an empty chat and a fresh start', async () => {
    const src = await seedSingle(single())
    const r = await forkChat(deps, src.id, 'u1')
    expect(await store.loadItems(r.chat.id)).toEqual([])
    expect(r.chat.sessionId).toBeNull()
    expect(r.chat.next).toBeUndefined()
    expect(r.draft).toEqual({ text: 'text u1', attachments: [] })
  })

  it('fork of a room keeps members, role and folder, and rewinds each member', async () => {
    const g = await store.createGroup(['ann', 'bob'], '/room', 'be nice')
    const items: ChatItem[] = [
      user('u1'),
      asst('a1', { agent: 'ann', cut: { session: 'sa', at: 'xa1' }, end: { agent: 'ann', session: 'sa', at: 'xa1', seen: 'u1' } }),
      asst('b1', { agent: 'bob', cut: { session: 'sb', at: 'xb1' }, end: { agent: 'bob', session: 'sb', at: 'xb1', seen: 'a1' } }),
      user('u2'),
      asst('a2', { agent: 'ann', cut: { session: 'sa', at: 'xa2' }, end: { agent: 'ann', session: 'sa', at: 'xa2', seen: 'u2' } })
    ]
    await store.saveItems(g.id, items)
    await store.updateGroup(g.id, (gi) => ({ ...gi, sessions: { ann: 'sa', bob: 'sb' }, seen: { ann: 'u2', bob: 'a1' } }))
    const r = await forkChat(deps, g.id, 'b1')
    expect(r.chat.agentName).toBe('')
    expect(r.chat.cwd).toBe('/room')
    expect(r.chat.group).toMatchObject({ members: ['ann', 'bob'], role: 'be nice', active: [], queue: [] })
    expect(r.chat.group?.sessions).toEqual({ ann: 'sa', bob: 'sb' })
    expect(r.chat.group?.next).toEqual({ ann: { at: 'xa1' }, bob: { at: 'xb1' } })
    expect(r.chat.group?.seen).toEqual({ ann: 'u1', bob: 'a1' })
    expect(ids(await store.loadItems(r.chat.id))).toEqual(['u1', 'a1', 'b1'])

    const early = await forkChat(deps, g.id, 'a1')
    expect(early.chat.group?.sessions).toEqual({ ann: 'sa', bob: null })
    expect(early.chat.group?.next).toEqual({ ann: { at: 'xa1' } })

    const r2 = await forkChat(deps, g.id, 'u2')
    expect(r2.chat.group?.next).toEqual({ ann: { at: 'xa1' }, bob: { at: 'xb1' } })
    expect(ids(await store.loadItems(r2.chat.id))).toEqual(['u1', 'a1', 'b1'])
  })

  it("fork of a room marks each member's session with its stamp's engine: a Codex thread is marked, a Claude session is not", async () => {
    const g = await store.createGroup(['ann', 'cx'], '/room')
    const items: ChatItem[] = [
      user('u1'),
      asst('a1', { agent: 'ann', cut: { session: 'sa', at: 'xa1' }, end: { agent: 'ann', session: 'sa', at: 'xa1', seen: 'u1' } }),
      asst('c1', { agent: 'cx', end: { agent: 'cx', session: 'th1', at: 'turn1', seen: 'a1', engine: 'codex' } }),
      user('u2'),
      asst('c2', { agent: 'cx', end: { agent: 'cx', session: 'th1', at: 'turn2', seen: 'u2', engine: 'codex' } })
    ]
    await store.saveItems(g.id, items)
    // The source's own marks are its current sessions'; a fork takes each member's from the stamp it cuts at.
    await store.updateGroup(g.id, (gi) => ({ ...gi, sessions: { ann: 'sa', cx: 'th1' }, sessionEngines: { cx: 'codex' } }))
    const atUser = await forkChat(deps, g.id, 'u2')
    expect(atUser.chat.group).toMatchObject({ sessions: { ann: 'sa', cx: 'th1' }, next: { ann: { at: 'xa1' }, cx: { at: 'turn1' } } })
    expect(atUser.chat.group?.sessionEngines).toEqual({ cx: 'codex' })
    // At a Codex reply that ends its turn: the member forks at that turn, on its thread.
    const atReply = await forkChat(deps, g.id, 'c2')
    expect(atReply.chat.group).toMatchObject({ sessions: { ann: 'sa', cx: 'th1' }, next: { ann: { at: 'xa1' }, cx: { at: 'turn2' } } })
    expect(atReply.chat.group?.sessionEngines).toEqual({ cx: 'codex' })
    // Before the Codex member's first turn it has no session, so no mark either.
    const early = await forkChat(deps, g.id, 'a1')
    expect(early.chat.group?.sessions).toEqual({ ann: 'sa', cx: null })
    expect(early.chat.group).not.toHaveProperty('sessionEngines')
  })

  it('fork of a room keeps its handoff, and a room without one gets none', async () => {
    const handoff = { text: 'Summary of the old room', from: { chatId: 'old', title: 'Old room' }, at: 123 }
    const g = await store.createGroup(['ann', 'bob'], '/room')
    await store.saveItems(g.id, [
      user('u1'),
      asst('a1', { agent: 'ann', cut: { session: 'sa', at: 'xa1' }, end: { agent: 'ann', session: 'sa', at: 'xa1', seen: 'u1' } })
    ])
    const plain = await forkChat(deps, g.id, 'a1')
    expect(plain.chat.group).not.toHaveProperty('handoff')
    await store.updateGroup(g.id, (gi) => ({ ...gi, handoff }))
    const r = await forkChat(deps, g.id, 'a1')
    expect(r.chat.group?.handoff).toEqual(handoff)
    expect((await store.get(r.chat.id))?.group?.handoff).toEqual(handoff)
  })

  it('fork of a room writes nothing for an author who left the room', async () => {
    const g = await store.createGroup(['ann'], '/room')
    await store.saveItems(g.id, [
      user('u1'),
      asst('b1', { agent: 'bob', cut: { session: 'sb', at: 'xb1' }, end: { agent: 'bob', session: 'sb', at: 'xb1', seen: 'u1' } })
    ])
    const r = await forkChat(deps, g.id, 'b1')
    const grp = r.chat.group!
    expect(Object.keys(grp.sessions)).not.toContain('bob')
    expect(Object.keys(grp.seen)).not.toContain('bob')
    expect(Object.keys(grp.next ?? {})).not.toContain('bob')
  })

  it('fork never changes the source chat', async () => {
    const withVersions: ChatItem[] = [user('u1', { versions: { root: 'u1', index: 1, count: 2 } }), ...single().slice(1)]
    const src = await seedSingle(withVersions)
    await store.saveVersions(src.id, { u1: { current: 1, list: [{ user: user('u0') as never, tail: [asst('h1')] }, null] } })
    const dir = join(tmp, 'data')
    const read = async () => ({
      index: await fs.readFile(join(dir, 'chats.json'), 'utf8'),
      items: await fs.readFile(join(dir, 'chats', `${src.id}.json`)),
      versions: await fs.readFile(join(dir, 'chats', `${src.id}.versions.json`))
    })
    const before = await read()
    const r = await forkChat(deps, src.id, 'a2')
    const after = await read()
    expect(after.items.equals(before.items)).toBe(true)
    expect(after.versions.equals(before.versions)).toBe(true)
    const srcMeta = JSON.parse(after.index).chats.find((c: ChatMeta) => c.id === src.id)
    expect(srcMeta).toEqual(JSON.parse(before.index).chats.find((c: ChatMeta) => c.id === src.id))
    expect(r.chat.id).not.toBe(src.id)
  })

  it("fork drops versions and copies attachments, so removing either chat keeps the other's files", async () => {
    const a = await files.stageBytes('pic.txt', Buffer.from('data'))
    if (!a.ok) throw new Error(a.error)
    const src = await store.create('helper', '/work')
    const [att] = await files.commit(src.id, [a.attachment.id])
    const items: ChatItem[] = [
      user('u1', { attachments: [att], versions: { root: 'u1', index: 0, count: 2 } }),
      asst('a1', { cut: { session: 's1', at: 'x1' } })
    ]
    await store.saveItems(src.id, items)
    await store.saveVersions(src.id, { u1: { current: 0, list: [null, { user: user('u1b') as never, tail: [] }] } })
    const r = await forkChat(deps, src.id, 'a1')
    const copied = await store.loadItems(r.chat.id)
    expect(copied[0]).not.toHaveProperty('versions')
    expect(await store.loadVersions(r.chat.id)).toEqual({})
    expect(await fs.readFile(files.pathOf(r.chat.id, att), 'utf8')).toBe('data')
    await files.removeChat(src.id)
    expect(await fs.readFile(files.pathOf(r.chat.id, att), 'utf8')).toBe('data')
    await files.removeChat(r.chat.id)
    await expect(fs.access(files.pathOf(r.chat.id, att))).rejects.toThrow()
  })

  it('a fork that fails after copying files removes the new chat and its attachments folder', async () => {
    const a = await files.stageBytes('pic.txt', Buffer.from('data'))
    if (!a.ok) throw new Error(a.error)
    const src = await store.create('helper', '/work')
    const [att] = await files.commit(src.id, [a.attachment.id])
    await store.saveItems(src.id, [user('u1', { attachments: [att] }), asst('a1', { cut: { session: 's1', at: 'x1' } })])
    const copy = vi.spyOn(files, 'copyFiles')
    vi.spyOn(store, 'update').mockRejectedValueOnce(new Error('disk full'))
    await expect(forkChat(deps, src.id, 'a1')).rejects.toThrow('disk full')
    expect(copy).toHaveBeenCalledTimes(1)
    const newId = copy.mock.calls[0][1]
    await expect(fs.access(files.pathOf(newId, att))).rejects.toThrow()
    await expect(fs.access(join(tmp, 'attachments', newId))).rejects.toThrow()
    expect((await store.list()).map((c) => c.id)).toEqual([src.id])
    expect(await fs.readFile(files.pathOf(src.id, att), 'utf8')).toBe('data')
  })

  describe('file copies', () => {
    const edit = (id: string, before: string | null, after: string | null): ChatItem =>
      ({
        type: 'tool',
        id,
        name: 'Edit',
        input: {},
        result: 'ok',
        isError: false,
        blocked: false,
        ts: 3,
        changes: [{ id, ts: 3, path: '/work/a.ts', op: 'update', patch: null, before, after }]
      }) as ChatItem
    const keep = async (chatId: string, text: string): Promise<string> => {
      const r = await snaps.put(chatId, text)
      if (!('id' in r)) throw new Error('not kept')
      return r.id
    }
    const has = (chatId: string, id: string) =>
      fs.access(snaps.pathOf(chatId, id)!).then(
        () => true,
        () => false
      )

    it('fork copies the copies its items name, and not those of hidden versions or later items', async () => {
      const src = await store.create('helper', '/work')
      const [b1, a1, hidden, later] = [
        await keep(src.id, 'one'),
        await keep(src.id, 'two'),
        await keep(src.id, 'hidden'),
        await keep(src.id, 'later')
      ]
      await store.saveItems(src.id, [
        user('u1', { versions: { root: 'u1', index: 0, count: 2 } }),
        edit('e1', b1, a1),
        asst('a1', { cut: { session: 's1', at: 'x1' } }),
        user('u2'),
        edit('e2', a1, later),
        asst('a2')
      ])
      await store.saveVersions(src.id, {
        u1: { current: 0, list: [null, { user: user('u1b') as never, tail: [edit('e9', null, hidden)] }] }
      })
      const r = await forkChat(deps, src.id, 'a1')
      expect(await has(r.chat.id, b1)).toBe(true)
      expect(await has(r.chat.id, a1)).toBe(true)
      expect(await has(r.chat.id, hidden)).toBe(false)
      expect(await has(r.chat.id, later)).toBe(false)
      // Independent copies: removing the source keeps the fork's.
      await snaps.removeChat(src.id)
      expect(await has(r.chat.id, a1)).toBe(true)
    })

    it("a fork that fails after copying removes the new chat's copies too", async () => {
      const src = await store.create('helper', '/work')
      const id = await keep(src.id, 'one')
      await store.saveItems(src.id, [user('u1'), edit('e1', null, id), asst('a1', { cut: { session: 's1', at: 'x1' } })])
      const copy = vi.spyOn(snaps, 'copy')
      vi.spyOn(store, 'update').mockRejectedValueOnce(new Error('disk full'))
      await expect(forkChat(deps, src.id, 'a1')).rejects.toThrow('disk full')
      const newId = copy.mock.calls[0][1]
      expect(await has(newId, id)).toBe(false)
      await expect(fs.access(join(tmp, 'snaps', newId))).rejects.toThrow()
      expect(await has(src.id, id)).toBe(true)
    })
  })

  it('fork copies no live item and a pending approval is not left pending', async () => {
    const src = await seedSingle([
      user('u1'),
      asst('a1', { cut: { session: 's1', at: 'x1' } }),
      {
        type: 'approval',
        id: 'p1',
        ts: 3,
        status: 'pending',
        toolName: 'Bash',
        input: {},
        description: null,
        reason: null,
        agent: 'helper'
      } as unknown as ChatItem,
      asst('live', { turn: 't1' })
    ])
    const r = await forkChat(deps, src.id, 'a1')
    expect(ids(await store.loadItems(r.chat.id))).toEqual(['u1', 'a1'])
    const r2 = await forkChat(deps, src.id, 'u1')
    expect(await store.loadItems(r2.chat.id)).toEqual([])
  })

  it("a fork does not inherit chat-scope allow rules, so a copied row's 'chat' mark is cleared and an 'agent' one stays", async () => {
    const refused = (id: string, allowedAs?: 'chat' | 'agent'): ChatItem =>
      ({
        type: 'tool',
        id,
        name: 'Bash',
        input: { command: 'git branch -D a' },
        result: null,
        isError: false,
        blocked: true,
        blockedBy: 'classifier',
        ts: 2,
        ...(allowedAs ? { allowedAs } : {})
      }) as ChatItem
    const src = await seedSingle(
      [user('u1'), refused('t1', 'chat'), refused('t2', 'agent'), refused('t3'), asst('a1', { cut: { session: 's1', at: 'x1' } })],
      { allowRules: ['Bash(git branch -D:*)'] }
    )
    const r = await forkChat(deps, src.id, 'a1')
    const copy = await store.loadItems(r.chat.id)
    const mark = (id: string) => (copy.find((i) => i.id === id) as Extract<ChatItem, { type: 'tool' }>).allowedAs
    expect(mark('t1')).toBeUndefined()
    expect(mark('t2')).toBe('agent')
    expect(mark('t3')).toBeUndefined()
    expect(r.chat.allowRules).toBeUndefined()
    // The source keeps its marks.
    const kept = (await store.loadItems(src.id)).find((i) => i.id === 't1') as Extract<ChatItem, { type: 'tool' }>
    expect(kept.allowedAs).toBe('chat')
  })

  it('a forked pending vault approval reads interrupted', async () => {
    const card = (id: string, status: 'pending' | 'allowed') =>
      ({
        type: 'vault-approval',
        id,
        ts: 3,
        agent: 'helper',
        request: {
          id,
          chatId: 'c',
          turnId: 't',
          profileId: 'p',
          itemId: 'i',
          itemName: 'Work Visa',
          label: 'Visa •4242',
          site: 'shop.example.com',
          frameSite: 'shop.example.com',
          status
        }
      }) as unknown as ChatItem
    const src = await seedSingle([
      user('u1'),
      card('v1', 'pending'),
      card('v2', 'allowed'),
      asst('a1', { cut: { session: 's1', at: 'x1' } })
    ])
    const r = await forkChat(deps, src.id, 'a1')
    const copied = await store.loadItems(r.chat.id)
    expect(copied.find((i) => i.id === 'v1')).toMatchObject({ request: { status: 'interrupted' } })
    expect(copied.find((i) => i.id === 'v2')).toMatchObject({ request: { status: 'allowed' } })
    // The source keeps its own pending card.
    expect((await store.loadItems(src.id)).find((i) => i.id === 'v1')).toMatchObject({ request: { status: 'pending' } })
  })

  it('fork of a live item throws Message not found', async () => {
    const src = await seedSingle([user('u1'), asst('live', { turn: 't1' })])
    await expect(forkChat(deps, src.id, 'live')).rejects.toThrow('Message not found')
    await expect(forkChat(deps, src.id, 'nope')).rejects.toThrow('Message not found')
    expect((await store.list()).length).toBe(1)
  })

  it('fork title is Fork of <title>, or Fork of chat', async () => {
    const a = await seedSingle(single())
    expect((await forkChat(deps, a.id, 'a1')).chat.title).toBe('Fork of Plan')
    const b = await seedSingle(single(), { title: '' })
    expect((await forkChat(deps, b.id, 'a1')).chat.title).toBe('Fork of chat')
  })

  it('fork copies the worktree, for a chat and a room, and a plain chat gets none', async () => {
    const wt = { root: '/r-a', branch: 'zumibot/a-1', source: '/r', folder: '/r', links: ['node_modules'] }
    const one = await seedSingle(single(), { cwd: '/r-a', worktree: wt })
    expect((await forkChat(deps, one.id, 'u2')).chat.worktree).toEqual(wt)
    const room = await store.createGroup(['a', 'b'], '/r-a', '')
    await store.saveItems(room.id, single())
    await store.update(room.id, { worktree: wt })
    const f = await forkChat(deps, room.id, 'u2')
    expect(f.chat).toMatchObject({ cwd: '/r-a', worktree: wt })
    const plain = await seedSingle(single())
    expect((await forkChat(deps, plain.id, 'u2')).chat).not.toHaveProperty('worktree')
  })
})
