import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { ChatStore } from '../../src/core/store/chatStore'
import { NOTICE_TEXT, type ChatItem } from '@zumibot/shared/types'
import { RESUME_TEXT } from '@zumibot/shared/pause'
import type { Versions } from '../../src/core/chat/versions'
import type { SideQuestion } from '@zumibot/shared/btw'
import { existsSync } from 'node:fs'
import { addTodos, askTodo, assignTodo, checkTodos, startTask, type TodoFile, type TodoSource } from '@zumibot/shared/todos'
import type { DispatchEntry } from '@zumibot/shared/dispatch'

let dir: string
let clock: number
let n: number
const mk = (d = dir) =>
  new ChatStore(
    d,
    () => ++clock,
    () => `id-${++n}`
  )

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-chats-'))
  clock = 1000
  n = 0
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('ChatStore', () => {
  it('create/list/get orders newest first', async () => {
    const s = mk()
    const a = await s.create('alpha', '/a')
    const b = await s.create('beta', '/b')
    expect(a).toMatchObject({ title: '', sessionId: null, inFlight: false, agentName: 'alpha', cwd: '/a' })
    expect((await s.list()).map((c) => c.id)).toEqual([b.id, a.id])
    expect(await s.get(a.id)).toEqual(a)
    expect(await s.get('nope')).toBeNull()
  })

  it('update bumps updatedAt and throws on unknown id', async () => {
    const s = mk()
    const a = await s.create('alpha', '/a')
    const u = await s.update(a.id, { title: 'T' })
    expect(u.title).toBe('T')
    expect(u.updatedAt).toBeGreaterThan(a.updatedAt)
    const fixed = await s.update(a.id, { updatedAt: 5 })
    expect(fixed.updatedAt).toBe(5)
    await expect(s.update('zzz', {})).rejects.toThrow('Chat not found: zzz')
  })

  describe('archive', () => {
    it('a turn starting takes the chat out of the archive', async () => {
      const s = mk()
      const a = await s.create('alpha', '/a')
      await s.patchInPlace(a.id, () => ({ archivedAt: 5000 }))
      clock = 1999
      const r = await s.update(a.id, { inFlight: true })
      // Past archivedAt even though the clock is behind it (synced from a faster machine).
      expect(r).toMatchObject({ inFlight: true, archivedAt: 5000, unarchivedAt: 5001 })
    })

    it('other updates leave an archived chat archived', async () => {
      const s = mk()
      const a = await s.create('alpha', '/a')
      await s.patchInPlace(a.id, () => ({ archivedAt: 1500 }))
      const r = await s.update(a.id, { title: 'x', inFlight: false })
      expect(r.archivedAt).toBe(1500)
      expect(r.unarchivedAt).toBeUndefined()
    })

    it('a chat not archived gets no unarchive time', async () => {
      const s = mk()
      const a = await s.create('alpha', '/a')
      expect((await s.update(a.id, { inFlight: true })).unarchivedAt).toBeUndefined()
    })
  })

  describe('patchInPlace', () => {
    it('writes the patch and keeps updatedAt', async () => {
      clock = 99
      const s = mk()
      const a = await s.create('alpha', '/a')
      expect(a.updatedAt).toBe(100)
      clock = 199
      const r = await s.patchInPlace(a.id, () => ({ seenAt: 150 }))
      expect(r).toMatchObject({ seenAt: 150, updatedAt: 100 })
      expect(await s.get(a.id)).toEqual(r)
    })

    it('null from fn writes nothing', async () => {
      const s = mk()
      const a = await s.create('alpha', '/a')
      const before = await fs.stat(join(dir, 'chats.json'))
      await new Promise((r) => setTimeout(r, 20))
      const fn = vi.fn(() => null)
      expect(await s.patchInPlace(a.id, fn)).toBeNull()
      expect(fn).toHaveBeenCalledWith(a)
      expect((await fs.stat(join(dir, 'chats.json'))).mtimeMs).toBe(before.mtimeMs)
      expect(await s.get(a.id)).toEqual(a)
    })

    it('unknown chat resolves null', async () => {
      const s = mk()
      const fn = vi.fn(() => ({ seenAt: 1 }))
      expect(await s.patchInPlace('nope', fn)).toBeNull()
      expect(fn).not.toHaveBeenCalled()
    })

    it('a concurrent update is not rolled back', async () => {
      clock = 99
      const s = mk()
      const a = await s.create('alpha', '/a')
      clock = 299
      // patch first: a read-then-write version would let the update land between its read and write
      const patch = s.patchInPlace(a.id, () => ({ seenAt: 1 }))
      const upd = s.update(a.id, { title: 'x' })
      await Promise.all([patch, upd])
      expect(await s.get(a.id)).toMatchObject({ title: 'x', seenAt: 1, updatedAt: 300 })
    })

    it('an update queued before it is kept too', async () => {
      clock = 99
      const s = mk()
      const a = await s.create('alpha', '/a')
      clock = 299
      const upd = s.update(a.id, { title: 'x' })
      const patch = s.patchInPlace(a.id, () => ({ seenAt: 1 }))
      await Promise.all([upd, patch])
      expect(await s.get(a.id)).toMatchObject({ title: 'x', seenAt: 1, updatedAt: 300 })
    })
  })

  describe('tasks', () => {
    const task = (id: string) => ({ id, text: `text ${id}`, ts: 1 })

    it('addTask appends in order and keeps updatedAt', async () => {
      const s = mk()
      const a = await s.create('alpha', '/a')
      await s.addTask(a.id, task('t1'))
      const meta = await s.addTask(a.id, task('t2'))
      expect(meta.tasks?.map((t) => t.id)).toEqual(['t1', 't2'])
      expect(meta.updatedAt).toBe(a.updatedAt)
      await expect(s.addTask('zzz', task('x'))).rejects.toThrow('Chat not found: zzz')
    })

    it('takeTask returns the oldest and removes it; empty list leaves tasks absent', async () => {
      const s = mk()
      const a = await s.create('alpha', '/a')
      await s.addTask(a.id, task('t1'))
      await s.addTask(a.id, task('t2'))
      const first = await s.takeTask(a.id)
      expect(first.task?.id).toBe('t1')
      expect(first.meta.tasks?.map((t) => t.id)).toEqual(['t2'])
      const second = await s.takeTask(a.id)
      expect(second.task?.id).toBe('t2')
      expect(second.meta.tasks).toBeUndefined()
      expect(second.meta.updatedAt).toBe(a.updatedAt)
      expect((await s.takeTask(a.id)).task).toBeNull()
      await expect(s.takeTask('zzz')).rejects.toThrow('Chat not found: zzz')
    })

    it('dropTask removes by id; unknown id returns null and changes nothing', async () => {
      const s = mk()
      const a = await s.create('alpha', '/a')
      await s.addTask(a.id, task('t1'))
      await s.addTask(a.id, task('t2'))
      const none = await s.dropTask(a.id, 'nope')
      expect(none.task).toBeNull()
      expect(none.meta.tasks?.map((t) => t.id)).toEqual(['t1', 't2'])
      const hit = await s.dropTask(a.id, 't1')
      expect(hit.task?.id).toBe('t1')
      expect(hit.meta.tasks?.map((t) => t.id)).toEqual(['t2'])
      expect((await s.dropTask(a.id, 't2')).meta.tasks).toBeUndefined()
      await expect(s.dropTask('zzz', 't')).rejects.toThrow('Chat not found: zzz')
    })

    it('tasks survive a reload', async () => {
      const s = mk()
      const a = await s.create('alpha', '/a')
      await s.addTask(a.id, task('t1'))
      const listed = await mk().list()
      expect(listed.find((c) => c.id === a.id)?.tasks?.map((t) => t.id)).toEqual(['t1'])
    })
  })

  it('renameAgent changes only matching chats', async () => {
    const s = mk()
    const a = await s.create('alpha', '/a')
    const b = await s.create('beta', '/b')
    await s.renameAgent('alpha', 'gamma')
    expect((await s.get(a.id))?.agentName).toBe('gamma')
    expect((await s.get(b.id))?.agentName).toBe('beta')
  })

  describe('renameAgent and asked chats', () => {
    const asked = async (s: ChatStore) => {
      const a = await s.create('a', '/a')
      const mid = await s.create('c', '/c')
      const b = await s.create('b', '/b')
      await s.update(b.id, { asked: { by: 'a', from: a.id, fromTitle: 'T', chain: ['a', 'c'] } })
      await s.saveItems(b.id, [
        { type: 'user', id: 'u1', text: 'q', ts: 1, from: 'a' },
        { type: 'user', id: 'u2', text: 'mine', ts: 2 }
      ] as ChatItem[])
      return { a, mid, b }
    }

    it('renaming the asked agent keeps the chat findable by (from, new name)', async () => {
      const s = mk()
      const { a, b } = await asked(s)
      await s.renameAgent('b', 'b2')
      const found = (await s.list()).find((c) => c.asked?.from === a.id && c.agentName === 'b2')
      expect(found?.id).toBe(b.id)
    })

    it('renaming the asking agent moves asked.by, asked.chain and the items from', async () => {
      const s = mk()
      const { b } = await asked(s)
      await s.renameAgent('a', 'a2')
      const got = (await s.get(b.id))!
      expect(got.asked?.by).toBe('a2')
      expect(got.asked?.chain).toEqual(['a2', 'c'])
      const items = await s.loadItems(b.id)
      expect(items.map((i) => (i.type === 'user' ? i.from : undefined))).toEqual(['a2', undefined])
    })
  })

  it('toggleReaction adds and removes an emoji, keeping the chat in its place', async () => {
    const s = mk()
    const a = await s.create('alpha', '/a')
    const r1 = await s.toggleReaction(a.id, 'm1', '👍')
    const r2 = await s.toggleReaction(a.id, 'm1', '🎉')
    expect(r2.reactions).toEqual({ m1: ['👍', '🎉'] })
    expect(r2.updatedAt).toBe(a.updatedAt)
    expect(r1.updatedAt).toBe(a.updatedAt)
    await s.toggleReaction(a.id, 'm2', '👀')
    expect((await s.toggleReaction(a.id, 'm1', '👍')).reactions).toEqual({ m1: ['🎉'], m2: ['👀'] })
    await s.toggleReaction(a.id, 'm1', '🎉')
    const last = await s.toggleReaction(a.id, 'm2', '👀')
    expect(last.reactions).toBeUndefined()
    expect(await mk().get(a.id)).not.toHaveProperty('reactions')
    await expect(s.toggleReaction('nope', 'm1', '👍')).rejects.toThrow('Chat not found')
  })

  it('a reaction survives a turn that updates the chat', async () => {
    const s = mk()
    const a = await s.create('alpha', '/a')
    await s.update(a.id, { inFlight: true })
    await s.toggleReaction(a.id, 'm1', '👍')
    expect((await s.update(a.id, { inFlight: false })).reactions).toEqual({ m1: ['👍'] })
  })

  it('items round-trip', async () => {
    const s = mk()
    const a = await s.create('alpha', '/a')
    const items: ChatItem[] = [
      { type: 'user', id: 'u', text: 'hi', ts: 1 },
      { type: 'tool', id: 't', name: 'Bash', input: { command: 'ls' }, result: 'x', isError: false, blocked: false, ts: 2 }
    ]
    await s.saveItems(a.id, items)
    expect(await mk().loadItems(a.id)).toEqual(items)
  })

  it('missing log loads empty', async () => {
    const s = mk()
    const a = await s.create('alpha', '/a')
    await s.saveItems(a.id, [{ type: 'user', id: 'u', text: 'hi', ts: 1 }])
    await fs.rm(join(dir, 'chats', `${a.id}.json`))
    expect(await s.loadItems(a.id)).toEqual([])
  })

  it('corrupt log is backed up and chat opens empty', async () => {
    const s = mk()
    const a = await s.create('alpha', '/a')
    await fs.mkdir(join(dir, 'chats'), { recursive: true })
    await fs.writeFile(join(dir, 'chats', `${a.id}.json`), '[{"type":')
    expect(await s.loadItems(a.id)).toEqual([])
    const baks = (await fs.readdir(join(dir, 'chats'))).filter((f) => f.startsWith(`${a.id}.json.bak-`))
    expect(baks).toHaveLength(1)
    expect(await fs.readFile(join(dir, 'chats', baks[0]), 'utf8')).toBe('[{"type":')
  })

  it('saveItems after remove is a no-op', async () => {
    const s = mk()
    const a = await s.create('alpha', '/a')
    await s.remove(a.id)
    await expect(s.saveItems(a.id, [{ type: 'user', id: 'u', text: 'hi', ts: 1 }])).resolves.toBeUndefined()
    await expect(fs.stat(join(dir, 'chats', `${a.id}.json`))).rejects.toThrow()
  })

  it('rejects unsafe ids', async () => {
    const s = mk()
    await expect(s.loadItems('../evil')).rejects.toThrow()
    await expect(s.saveItems('a/b', [])).rejects.toThrow()
  })

  it('remove deletes entry and log', async () => {
    const s = mk()
    const a = await s.create('alpha', '/a')
    await s.saveItems(a.id, [])
    await s.remove(a.id)
    expect(await s.list()).toEqual([])
    await expect(fs.stat(join(dir, 'chats', `${a.id}.json`))).rejects.toThrow()
    await s.remove(a.id)
  })

  it('corrupt index is backed up', async () => {
    await fs.writeFile(join(dir, 'chats.json'), '{"chats": [')
    const s = mk()
    expect(await s.list()).toEqual([])
    const baks = (await fs.readdir(dir)).filter((f) => f.startsWith('chats.json.bak-'))
    expect(baks).toHaveLength(1)
    expect(await fs.readFile(join(dir, baks[0]), 'utf8')).toBe('{"chats": [')
  })

  it("concurrent updates don't lose writes", async () => {
    const s = mk()
    const chats = []
    for (let i = 0; i < 20; i++) chats.push(await s.create('a', `/${i}`))
    await Promise.all(chats.map((c, i) => s.update(c.id, { title: `t${i}` })))
    const fresh = mk()
    for (let i = 0; i < 20; i++) expect((await fresh.get(chats[i].id))?.title).toBe(`t${i}`)
  })

  it('recoverInterrupted appends notice and clears inFlight', async () => {
    const s = mk()
    const a = await s.create('alpha', '/a')
    await s.create('beta', '/b')
    await s.update(a.id, { inFlight: true })
    const ids = await s.recoverInterrupted()
    expect(ids).toEqual([a.id])
    expect((await s.get(a.id))?.inFlight).toBe(false)
    const items = await s.loadItems(a.id)
    expect(items.at(-1)).toMatchObject({ type: 'notice', kind: 'interrupted', text: NOTICE_TEXT.interrupted })
  })
  it('recoverInterrupted turns pending cards into unanswered', async () => {
    const s = mk()
    const a = await s.create('alpha', '/a')
    const card = (id: string, status: 'pending' | 'allowed-once'): ChatItem => ({
      type: 'approval',
      id,
      toolUseId: null,
      toolName: 'Bash',
      input: { command: 'ls' },
      description: null,
      reason: null,
      status,
      ts: 1
    })
    await s.saveItems(a.id, [{ type: 'user', id: 'u1', text: 'hi', ts: 1 }, card('r1', 'pending'), card('r2', 'allowed-once')])
    await s.update(a.id, { inFlight: true })
    await s.recoverInterrupted()
    const items = await s.loadItems(a.id)
    expect(items).toHaveLength(4)
    expect(items[1]).toMatchObject({ id: 'r1', status: 'unanswered' })
    expect(items[2]).toMatchObject({ id: 'r2', status: 'allowed-once' })
    expect(items[3]).toMatchObject({ type: 'notice', kind: 'interrupted' })
    expect((await s.get(a.id))?.inFlight).toBe(false)
  })

  it('old logs load unchanged', async () => {
    const s = mk()
    const a = await s.create('alpha', '/a')
    const stored: ChatItem[] = [
      { type: 'user', id: 'u1', text: 'hi', ts: 1 },
      { type: 'assistant', id: 'a1', text: 'yo', ts: 2 },
      { type: 'tool', id: 't1', name: 'Bash', input: {}, result: 'ok', isError: false, blocked: false, ts: 3 },
      { type: 'notice', id: 'n1', kind: 'stopped', text: NOTICE_TEXT.stopped, ts: 4 },
      { type: 'error', id: 'e1', text: 'boom', ts: 5 }
    ]
    await s.saveItems(a.id, stored)
    expect(await mk().loadItems(a.id)).toEqual(stored)
  })

  describe('groups', () => {
    const emptyGroup = (members: string[]) => ({ members, sessions: {}, seen: {}, role: '', active: [], queue: [] })

    it('creates a group chat', async () => {
      const s = mk()
      const g = await s.createGroup(['a', 'b'], '/g')
      expect(g).toMatchObject({ agentName: '', cwd: '/g', sessionId: null, inFlight: false })
      expect(g.group).toEqual(emptyGroup(['a', 'b']))
      expect((await s.list()).map((c) => c.id)).toEqual([g.id])
    })

    it('keeps single chats free of a group key', async () => {
      const s = mk()
      await s.create('helper', '/a')
      const raw = JSON.parse(await fs.readFile(join(dir, 'chats.json'), 'utf8'))
      expect('group' in raw.chats[0]).toBe(false)
    })

    it('updates a group atomically', async () => {
      const s = mk()
      const g = await s.createGroup(['a', 'b'], '/g')
      await Promise.all([
        s.updateGroup(g.id, (x) => ({ ...x, queue: [{ agent: 'b', after: [] }] })),
        s.updateGroup(g.id, (x) => ({ ...x, sessions: { ...x.sessions, a: 's1' } }))
      ])
      expect((await s.get(g.id))?.group).toMatchObject({ queue: [{ agent: 'b', after: [] }], sessions: { a: 's1' } })
    })

    it('throws when updating a non-group chat', async () => {
      const s = mk()
      const c = await s.create('a', '/a')
      await expect(s.updateGroup(c.id, (x) => x)).rejects.toThrow(`Not a group chat: ${c.id}`)
    })

    it('renames a member everywhere in groups', async () => {
      const s = mk()
      const single = await s.create('a', '/a')
      const g = await s.createGroup(['a', 'b'], '/g')
      await s.updateGroup(g.id, (x) => ({
        ...x,
        sessions: { a: 's1', b: null },
        seen: { a: 'i1', b: null },
        active: [{ agent: 'a', turn: 't', since: 1 }],
        queue: [
          { agent: 'a', after: [] },
          { agent: 'b', after: ['a'] }
        ]
      }))
      await s.saveItems(g.id, [
        { type: 'user', id: 'u1', text: 'hi', ts: 1 },
        { type: 'assistant', id: 'a1', text: 'yo', ts: 2, agent: 'a' },
        { type: 'assistant', id: 'a2', text: 'yo', ts: 3, agent: 'b' }
      ])
      await s.renameAgent('a', 'z')
      const got = await s.get(g.id)
      expect(got?.group).toEqual({
        members: ['z', 'b'],
        sessions: { z: 's1', b: null },
        seen: { z: 'i1', b: null },
        role: '',
        active: [{ agent: 'z', turn: 't', since: 1 }],
        queue: [
          { agent: 'z', after: [] },
          { agent: 'b', after: ['z'] }
        ]
      })
      const items = await s.loadItems(g.id)
      expect(items.map((i) => ('agent' in i ? i.agent : undefined))).toEqual([undefined, 'z', 'b'])
      expect((await s.get(single.id))?.agentName).toBe('z')
    })

    it('recovers an interrupted group', async () => {
      const s = mk()
      const g = await s.createGroup(['a', 'b'], '/g')
      await s.updateGroup(g.id, (x) => ({ ...x, active: [{ agent: 'a', turn: 't', since: 1 }], queue: [{ agent: 'b', after: ['a'] }] }))
      await s.update(g.id, { inFlight: true })
      await s.recoverInterrupted()
      const got = await s.get(g.id)
      expect(got?.inFlight).toBe(false)
      expect(got?.group).toMatchObject({ queue: [], active: [] })
      const items = await s.loadItems(g.id)
      expect(items[items.length - 1]).toMatchObject({ type: 'notice', kind: 'interrupted' })
    })

    it('migrates a legacy group record', async () => {
      const legacy = { members: ['a', 'b'], sessions: {}, seen: {}, activeAgent: 'a', queue: ['b', 'a'] }
      const meta = {
        id: 'g1',
        agentName: '',
        sessionId: null,
        cwd: '/g',
        title: '',
        createdAt: 1,
        updatedAt: 1,
        inFlight: false,
        group: legacy
      }
      await fs.writeFile(join(dir, 'chats.json'), JSON.stringify({ chats: [meta] }))
      const got = await mk().get('g1')
      expect(got?.group).toEqual({
        members: ['a', 'b'],
        sessions: {},
        seen: {},
        role: '',
        active: [],
        queue: [
          { agent: 'b', after: [] },
          { agent: 'a', after: ['b'] }
        ]
      })
    })

    it('createGroup stores the role', async () => {
      const g = await mk().createGroup(['a', 'b'], dir, 'rules')
      expect(g.group).toMatchObject({ role: 'rules', active: [], queue: [] })
    })

    it('renames a member in active and queue waits', async () => {
      const s = mk()
      const g = await s.createGroup(['a', 'b'], '/g')
      await s.updateGroup(g.id, (x) => ({
        ...x,
        active: [{ agent: 'a', turn: 't', since: 1 }],
        queue: [{ agent: 'b', after: ['a'] }]
      }))
      await s.renameAgent('a', 'z')
      const got = (await s.get(g.id))?.group
      expect(got?.active[0].agent).toBe('z')
      expect(got?.queue[0].after).toEqual(['z'])
    })

    it('recovers each live turn as its own block', async () => {
      const s = mk()
      const g = await s.createGroup(['a', 'b'], '/g')
      await s.update(g.id, { inFlight: true })
      await s.updateGroup(g.id, (x) => ({
        ...x,
        active: [
          { agent: 'a', turn: 't1', since: 1 },
          { agent: 'b', turn: 't2', since: 2 }
        ]
      }))
      const tool = (turn: string): ChatItem => ({
        type: 'tool',
        id: 'tool1',
        name: 'Bash',
        input: {},
        result: null,
        isError: false,
        blocked: false,
        ts: 4,
        turn
      })
      await s.saveItems(g.id, [
        { type: 'user', id: 'u1', text: 'hi', ts: 1 },
        { type: 'assistant', id: 'a1', text: 'one', ts: 2, agent: 'a', turn: 't1' },
        { type: 'assistant', id: 'a2', text: 'two', ts: 3, agent: 'b', turn: 't2' },
        tool('t1'),
        {
          type: 'approval',
          id: 'ap1',
          toolUseId: null,
          toolName: 'Bash',
          input: {},
          description: null,
          reason: null,
          status: 'pending',
          ts: 5,
          agent: 'b',
          turn: 't2'
        },
        { type: 'user', id: 'u2', text: 'more', ts: 6 }
      ])
      await s.recoverInterrupted()
      const items = await s.loadItems(g.id)
      expect(items.map((i) => (i.type === 'notice' ? i.kind : i.id))).toEqual([
        'u1',
        'u2',
        'a1',
        'tool1',
        'interrupted',
        'a2',
        'ap1',
        'interrupted'
      ])
      expect(items.some((i) => 'turn' in i)).toBe(false)
      expect(items.find((i) => i.id === 'ap1')).toMatchObject({ status: 'unanswered' })
      expect((await s.get(g.id))?.group).toMatchObject({ active: [], queue: [] })
    })

    it('recovers an in-flight group with no live items with one notice', async () => {
      const s = mk()
      const g = await s.createGroup(['a', 'b'], '/g')
      await s.update(g.id, { inFlight: true })
      await s.saveItems(g.id, [{ type: 'user', id: 'u1', text: 'hi', ts: 1 }])
      await s.recoverInterrupted()
      expect((await s.loadItems(g.id)).map((i) => i.type)).toEqual(['user', 'notice'])
    })
  })
})

describe('recovering a chat that was pausing', () => {
  const task = (id: string) => ({ id, text: id, attachments: [], ts: 1 }) as never
  const kinds = (items: ChatItem[]) => items.map((i) => (i.type === 'notice' ? i.kind : i.id))
  const userPausedCount = (items: ChatItem[]) => items.filter((i) => i.type === 'notice' && i.kind === 'userPaused').length

  it('lands a pausing single chat as paused and held, items ending interrupted then userPaused', async () => {
    const s = mk()
    const c = await s.create('alpha', '/a')
    await s.saveItems(c.id, [{ type: 'user', id: 'u1', text: 'hi', ts: 1 }])
    await s.update(c.id, { inFlight: true, pause: 'pausing' })
    await s.addTask(c.id, task('t1'))
    await s.addTask(c.id, task('t2'))
    const ids = await s.recoverInterrupted()
    expect(ids).toEqual([c.id])
    const got = await s.get(c.id)
    expect(got).toMatchObject({ pause: 'paused', held: true, inFlight: false })
    expect(got?.tasks).toHaveLength(2)
    const items = await s.loadItems(c.id)
    expect(kinds(items)).toEqual(['u1', 'interrupted', 'userPaused'])
    expect(items.at(-1)).toMatchObject({ type: 'notice', kind: 'userPaused', text: NOTICE_TEXT.userPaused })
  })

  it('saves the working members and the stored queue of a pausing room, and clears them', async () => {
    const s = mk()
    const g = await s.createGroup(['a', 'b', 'c'], '/g')
    await s.update(g.id, { inFlight: true, pause: 'pausing' })
    await s.updateGroup(g.id, (x) => ({
      ...x,
      active: [
        { agent: 'a', turn: 't1', since: 1 },
        { agent: 'b', turn: 't2', since: 2 }
      ],
      queue: [{ agent: 'c', after: ['a'] }]
    }))
    await s.saveItems(g.id, [{ type: 'user', id: 'u1', text: 'hi', ts: 1 }])
    expect(await s.recoverInterrupted()).toEqual([g.id])
    const got = await s.get(g.id)
    expect(got).toMatchObject({ pause: 'paused', inFlight: false })
    expect(got?.group).toMatchObject({ active: [], queue: [], paused: { members: ['a', 'b'], queue: [{ agent: 'c', after: ['a'] }] } })
    expect(got?.group?.paused).not.toHaveProperty('reasons')
    expect(kinds(await s.loadItems(g.id)).slice(-2)).toEqual(['interrupted', 'userPaused'])
  })

  it("keeps a pausing room's saved paused state", async () => {
    const s = mk()
    const g = await s.createGroup(['a', 'b'], '/g')
    await s.update(g.id, { inFlight: true, pause: 'pausing' })
    await s.updateGroup(g.id, (x) => ({
      ...x,
      active: [{ agent: 'a', turn: 't1', since: 1 }],
      queue: [{ agent: 'b', after: [] }],
      paused: { members: ['b'], queue: [{ agent: 'a', after: ['b'] }], reasons: { a: 'user' } as never }
    }))
    await s.recoverInterrupted()
    const got = await s.get(g.id)
    expect(got?.group).toMatchObject({
      active: [],
      queue: [],
      paused: { members: ['b'], queue: [{ agent: 'a', after: ['b'] }], reasons: { a: 'user' } }
    })
    expect(got?.pause).toBe('paused')
  })

  it('moves a pausing chat whose reply already ended to paused with a notice, tray held, updatedAt kept', async () => {
    const s = mk()
    const c = await s.create('alpha', '/a')
    await s.saveItems(c.id, [
      { type: 'user', id: 'u1', text: 'hi', ts: 1 },
      { type: 'assistant', id: 'a1', text: 'ok', ts: 2 }
    ])
    await s.update(c.id, { pause: 'pausing' })
    await s.addTask(c.id, task('t1'))
    const before = (await s.get(c.id))?.updatedAt
    expect(await s.recoverInterrupted()).toEqual([c.id])
    expect(await s.get(c.id)).toMatchObject({ pause: 'paused', held: true, inFlight: false, updatedAt: before })
    expect(kinds(await s.loadItems(c.id))).toEqual(['u1', 'a1', 'userPaused'])
  })

  it('leaves a chat that is already paused as it is', async () => {
    const s = mk()
    const c = await s.create('alpha', '/a')
    await s.saveItems(c.id, [
      { type: 'user', id: 'u1', text: 'hi', ts: 1 },
      { type: 'notice', id: 'n1', kind: 'userPaused', text: NOTICE_TEXT.userPaused, ts: 2 }
    ])
    await s.update(c.id, { pause: 'paused' })
    await s.addTask(c.id, task('t1'), true)
    const before = await s.get(c.id)
    expect(await s.recoverInterrupted()).toEqual([])
    expect(await s.get(c.id)).toEqual(before)
    expect(kinds(await s.loadItems(c.id))).toEqual(['u1', 'userPaused'])
  })

  it('adds the missing marker to a paused chat a crash cut short between the paused write and the items save, updatedAt kept', async () => {
    const s = mk()
    const c = await s.create('alpha', '/a')
    await s.saveItems(c.id, [
      { type: 'user', id: 'u1', text: 'hi', ts: 1 },
      { type: 'assistant', id: 'a1', text: 'ok', ts: 2 }
    ])
    await s.update(c.id, { pause: 'paused' })
    await s.addTask(c.id, task('t1'), true)
    const before = await s.get(c.id)
    expect(await s.recoverInterrupted()).toEqual([c.id])
    expect(await s.get(c.id)).toEqual(before)
    const items = await s.loadItems(c.id)
    expect(kinds(items)).toEqual(['u1', 'a1', 'userPaused'])
    expect(items.at(-1)).toMatchObject({ type: 'notice', kind: 'userPaused', text: NOTICE_TEXT.userPaused })
    // Once is enough.
    expect(await s.recoverInterrupted()).toEqual([])
    expect(userPausedCount(await s.loadItems(c.id))).toBe(1)
  })

  it('an older Paused notice does not count: the marker goes after what came since', async () => {
    const s = mk()
    const c = await s.create('alpha', '/a')
    await s.saveItems(c.id, [
      { type: 'notice', id: 'n0', kind: 'userPaused', text: NOTICE_TEXT.userPaused, ts: 1 },
      { type: 'user', id: 'u1', text: RESUME_TEXT, ts: 2 },
      { type: 'assistant', id: 'a1', text: 'ok', ts: 3 }
    ])
    await s.update(c.id, { pause: 'paused' })
    await s.recoverInterrupted()
    expect(kinds(await s.loadItems(c.id))).toEqual(['userPaused', 'u1', 'a1', 'userPaused'])
  })

  it('a room a crash cut short between landing its pause and clearing inFlight ends as a pausing one does', async () => {
    const s = mk()
    const g = await s.createGroup(['a', 'b', 'c'], '/g')
    await s.update(g.id, { inFlight: true, pause: 'paused' })
    await s.updateGroup(g.id, (x) => ({ ...x, active: [], queue: [{ agent: 'c', after: ['a'] }] }))
    await s.saveItems(g.id, [
      { type: 'user', id: 'u1', text: 'hi', ts: 1 },
      { type: 'assistant', id: 'a1', text: 'ok', ts: 2, agent: 'a', turn: 't1' }
    ])
    await s.addTask(g.id, task('t1'))
    expect(await s.recoverInterrupted()).toEqual([g.id])
    const got = await s.get(g.id)
    expect(got).toMatchObject({ pause: 'paused', held: true, inFlight: false })
    expect(got?.group).toMatchObject({ active: [], queue: [], paused: { members: [], queue: [{ agent: 'c', after: ['a'] }] } })
    expect(kinds(await s.loadItems(g.id))).toEqual(['u1', 'a1', 'interrupted', 'userPaused'])
    expect(await s.recoverInterrupted()).toEqual([])
    expect(userPausedCount(await s.loadItems(g.id))).toBe(1)
  })

  it('treats a chat with no pause exactly as before', async () => {
    const s = mk()
    const c = await s.create('alpha', '/a')
    await s.update(c.id, { inFlight: true })
    await s.addTask(c.id, task('t1'))
    await s.recoverInterrupted()
    const got = await s.get(c.id)
    expect(got).toMatchObject({ inFlight: false })
    expect(got).not.toHaveProperty('pause')
    expect(got?.held).toBeUndefined()
    expect(kinds(await s.loadItems(c.id))).toEqual(['interrupted'])
  })

  it('is idempotent: a second recovery adds no second marker', async () => {
    const s = mk()
    const c = await s.create('alpha', '/a')
    await s.update(c.id, { inFlight: true, pause: 'pausing' })
    await s.addTask(c.id, task('t1'))
    await s.recoverInterrupted()
    expect(await s.recoverInterrupted()).toEqual([])
    expect(userPausedCount(await s.loadItems(c.id))).toBe(1)
    const p = await s.create('beta', '/b')
    await s.update(p.id, { pause: 'pausing' })
    await s.recoverInterrupted()
    await s.recoverInterrupted()
    expect(userPausedCount(await s.loadItems(p.id))).toBe(1)
  })
})

describe('persisted browser handoff cards', () => {
  const card = (): Extract<ChatItem, { type: 'browser-action' }> => ({
    type: 'browser-action',
    id: 'card',
    ts: 1,
    agent: 'alpha',
    turn: 'group-live',
    handoff: {
      id: 'card',
      profileId: 'profile',
      generation: 'generation',
      chatId: 'chat',
      turnId: 'immutable-attempt',
      agent: 'alpha',
      site: 'example.com',
      reason: 'Sign in',
      createdAt: 1,
      status: 'pending'
    }
  })
  it.each([true, false])('recovers pending cards with inFlight=%s without losing immutable handoff identity', async (inFlight) => {
    const s = mk(),
      c = await s.create('alpha', '/a')
    await s.saveItems(c.id, [card()])
    await s.update(c.id, { inFlight })
    await s.recoverInterrupted()
    const recovered = (await s.loadItems(c.id)).find((i) => i.type === 'browser-action')
    expect(recovered).toMatchObject({ handoff: { status: 'interrupted', turnId: 'immutable-attempt' } })
    if (inFlight) expect(recovered).not.toHaveProperty('turn')
  })
  it('renames browser card author and handoff metadata in single and former-member group histories', async () => {
    const s = mk(),
      single = await s.create('alpha', '/a'),
      group = await s.createGroup(['beta', 'gamma'], '/g', '')
    for (const c of [single, group]) await s.saveItems(c.id, [card()])
    await s.renameAgent('alpha', 'renamed')
    for (const c of [single, group])
      expect((await s.loadItems(c.id))[0]).toMatchObject({
        agent: 'renamed',
        handoff: { agent: 'renamed', turnId: 'immutable-attempt', profileId: 'profile' }
      })
  })
  it.each([true, false])('a desktop card keeps its surface through restart recovery (inFlight=%s) and rename', async (inFlight) => {
    const s = mk(),
      c = await s.create('alpha', '/a')
    await s.saveItems(c.id, [{ ...card(), surface: 'desktop' }])
    await s.update(c.id, { inFlight })
    await s.recoverInterrupted()
    await s.renameAgent('alpha', 'renamed')
    expect((await s.loadItems(c.id)).find((i) => i.type === 'browser-action')).toMatchObject({
      surface: 'desktop',
      agent: 'renamed',
      handoff: { status: 'interrupted', agent: 'renamed' }
    })
  })
})

describe('persisted vault approval cards', () => {
  const card = (
    status: Extract<ChatItem, { type: 'vault-approval' }>['request']['status'] = 'pending'
  ): Extract<ChatItem, { type: 'vault-approval' }> => ({
    type: 'vault-approval',
    id: 'vcard',
    ts: 1,
    agent: 'alpha',
    turn: 'group-live',
    request: {
      id: 'vcard',
      chatId: 'chat',
      turnId: 'attempt',
      profileId: 'profile',
      itemId: 'item',
      itemName: 'Work Visa',
      label: 'Visa •4242',
      site: 'shop.example.com',
      frameSite: 'shop.example.com',
      status
    }
  })
  it.each([true, false])('a pending vault approval reads interrupted after a restart (inFlight=%s)', async (inFlight) => {
    const s = mk(),
      c = await s.create('alpha', '/a')
    await s.saveItems(c.id, [card(), { ...card('allowed'), id: 'done' }])
    await s.update(c.id, { inFlight })
    await s.recoverInterrupted()
    const items = await s.loadItems(c.id)
    expect(items.find((i) => i.id === 'vcard')).toMatchObject({ request: { status: 'interrupted', turnId: 'attempt' } })
    expect(items.find((i) => i.id === 'done')).toMatchObject({ request: { status: 'allowed' } })
  })
  it('renames the author of a vault approval card', async () => {
    const s = mk(),
      c = await s.create('alpha', '/a')
    await s.saveItems(c.id, [card()])
    await s.renameAgent('alpha', 'renamed')
    expect((await s.loadItems(c.id))[0]).toMatchObject({ agent: 'renamed', request: { id: 'vcard' } })
  })
})

describe('versions storage', () => {
  const user = (id: string): Extract<ChatItem, { type: 'user' }> => ({ type: 'user', id, text: id, ts: 1 })
  const versions = (agent: string): Versions => ({
    m: {
      current: 1,
      list: [
        {
          user: user('m'),
          tail: [
            { type: 'assistant', id: 'h1', text: 'x', ts: 1, agent, end: { session: 's', at: 'u', agent } },
            { type: 'user', id: 'h2', text: 'y', ts: 1 }
          ]
        },
        null
      ]
    }
  })

  it('versions round-trip and are removed with the chat', async () => {
    const s = mk(),
      a = await s.create('alpha', '/a')
    expect(await s.loadVersions(a.id)).toEqual({})
    const v = versions('alpha')
    await s.saveVersions(a.id, v)
    expect(await mk().loadVersions(a.id)).toEqual(v)
    expect(await s.loadItems(a.id)).toEqual([])
    await s.saveVersions(a.id, {})
    await expect(fs.stat(join(dir, 'chats', `${a.id}.versions.json`))).rejects.toThrow()
    await s.saveVersions(a.id, v)
    await s.remove(a.id)
    await expect(fs.stat(join(dir, 'chats', `${a.id}.versions.json`))).rejects.toThrow()
    await s.saveVersions(a.id, v)
    await expect(fs.stat(join(dir, 'chats', `${a.id}.versions.json`))).rejects.toThrow()
    await expect(s.loadVersions('../evil')).rejects.toThrow()
  })

  it('a corrupt versions file is backed up', async () => {
    const s = mk(),
      a = await s.create('alpha', '/a')
    await fs.mkdir(join(dir, 'chats'), { recursive: true })
    await fs.writeFile(join(dir, 'chats', `${a.id}.versions.json`), '{"m": [')
    expect(await s.loadVersions(a.id)).toEqual({})
    const baks = (await fs.readdir(join(dir, 'chats'))).filter((f) => f.startsWith(`${a.id}.versions.json.bak-`))
    expect(baks).toHaveLength(1)
  })

  it('renameAgent rewrites hidden items, end stamps and group next keys', async () => {
    const s = mk(),
      single = await s.create('alpha', '/a'),
      group = await s.createGroup(['alpha', 'beta'], '/g', '')
    await s.updateGroup(group.id, (g) => ({ ...g, next: { alpha: { at: 'u1' }, beta: { seed: true } } }))
    for (const c of [single, group]) {
      await s.saveVersions(c.id, versions('alpha'))
      await s.saveItems(c.id, [
        user('v'),
        { type: 'notice', id: 'n', kind: 'stopped', text: 't', ts: 1, end: { session: 's', at: 'u', agent: 'alpha', seen: null } },
        { type: 'assistant', id: 'o', text: 'o', ts: 1, agent: 'beta', end: { session: 's2', at: 'u2', agent: 'beta' } }
      ])
    }
    await s.renameAgent('alpha', 'renamed')
    for (const c of [single, group]) {
      const hidden = (await s.loadVersions(c.id)).m.list[0]!
      expect(hidden.tail[0]).toMatchObject({ agent: 'renamed', end: { agent: 'renamed', session: 's' } })
      expect(hidden.tail[1]).toEqual({ type: 'user', id: 'h2', text: 'y', ts: 1 })
      const items = await s.loadItems(c.id)
      expect(items[1]).toMatchObject({ end: { agent: 'renamed', seen: null } })
      expect(items[2]).toMatchObject({ agent: 'beta', end: { agent: 'beta' } })
    }
    expect((await s.get(group.id))?.group?.next).toEqual({ renamed: { at: 'u1' }, beta: { seed: true } })
  })

  it('rename moves stored and queued commands', async () => {
    const s = mk(),
      single = await s.create('wk', '/a'),
      group = await s.createGroup(['wk', 'ui'], '/g', '')
    const cmd = (agent: string) => ({ agent, name: 'check', prompt: 'Use check' })
    const task = (id: string, agent: string) => ({ id, text: '/check', ts: 1, command: cmd(agent) })
    for (const c of [single, group]) {
      await s.saveItems(c.id, [
        { ...user('v'), command: cmd('wk') },
        { ...user('w'), id: 'w', command: cmd('ui') }
      ])
      await s.addTask(c.id, task('t1', 'wk'))
      await s.addTask(c.id, task('t2', 'ui'))
      const v = versions('wk')
      v.m.list[0]!.tail = [{ type: 'user', id: 'h', text: 'x', ts: 1, command: cmd('wk') }, ...v.m.list[0]!.tail]
      await s.saveVersions(c.id, v)
    }
    await s.renameAgent('wk', 'wk2')
    for (const c of [single, group]) {
      const items = await s.loadItems(c.id)
      expect(items.map((i) => (i.type === 'user' ? i.command?.agent : null))).toEqual(['wk2', 'ui'])
      expect((await s.get(c.id))?.tasks?.map((t) => t.command?.agent)).toEqual(['wk2', 'ui'])
      expect((await s.loadVersions(c.id)).m.list[0]!.tail[0]).toMatchObject({ command: { agent: 'wk2' } })
    }
  })

  it('holdTasks holds only with tasks, and the last take or drop clears it', async () => {
    const s = mk(),
      a = await s.create('alpha', '/a')
    const task = (id: string) => ({ id, text: id, ts: 1 })
    expect((await s.holdTasks(a.id)).held).toBeUndefined()
    await s.addTask(a.id, task('t1'))
    await s.addTask(a.id, task('t2'))
    const held = await s.holdTasks(a.id)
    expect(held.held).toBe(true)
    expect(held.updatedAt).toBe(a.updatedAt)
    expect((await s.takeTask(a.id)).meta.held).toBe(true)
    expect((await s.takeTask(a.id)).meta.held).toBeUndefined()
    await s.addTask(a.id, task('t3'))
    await s.addTask(a.id, task('t4'))
    await s.holdTasks(a.id)
    expect((await s.dropTask(a.id, 't3')).meta.held).toBe(true)
    expect((await s.dropTask(a.id, 't4')).meta.held).toBeUndefined()
    await expect(s.holdTasks('zzz')).rejects.toThrow('Chat not found: zzz')
  })

  it('renameAgent moves a member meter to the new name', async () => {
    const s = mk(),
      group = await s.createGroup(['alpha', 'beta'], '/g', '')
    await s.updateGroup(group.id, (g) => ({ ...g, context: { alpha: { used: 1, window: 2 }, beta: { used: 3, window: 4 } } }))
    await s.renameAgent('alpha', 'renamed')
    expect((await s.get(group.id))?.group?.context).toEqual({ renamed: { used: 1, window: 2 }, beta: { used: 3, window: 4 } })
  })

  it("renameAgent moves a member's session engine with its session", async () => {
    const s = mk(),
      group = await s.createGroup(['alpha', 'beta'], '/g', '')
    await s.updateGroup(group.id, (g) => ({ ...g, sessions: { alpha: 'th-1', beta: 's-2' }, sessionEngines: { alpha: 'codex' } }))
    await s.renameAgent('alpha', 'renamed')
    expect((await s.get(group.id))?.group).toMatchObject({
      sessions: { renamed: 'th-1', beta: 's-2' },
      sessionEngines: { renamed: 'codex' }
    })
    // A room with no Codex session gets no map.
    const plain = await s.createGroup(['alpha', 'beta'], '/g', '')
    await s.renameAgent('beta', 'b2')
    expect((await s.get(plain.id))?.group).not.toHaveProperty('sessionEngines')
  })

  it('renameAgent moves a member inside a paused room and its lost subagents', async () => {
    const s = mk(),
      group = await s.createGroup(['alpha', 'beta', 'gamma'], '/g', '')
    await s.updateGroup(group.id, (g) => ({
      ...g,
      paused: {
        members: ['alpha', 'gamma'],
        queue: [
          { agent: 'alpha', after: ['alpha'] },
          { agent: 'beta', after: ['alpha', 'gamma'] }
        ],
        reasons: { alpha: { kind: 'agent', by: 'gamma' }, beta: { kind: 'agent', by: 'alpha', note: 'n' }, gamma: { kind: 'user' } }
      },
      lost: { alpha: ['Search the logs'], beta: ['Read the spec'] }
    }))
    await s.renameAgent('alpha', 'renamed')
    const got = (await s.get(group.id))?.group
    expect(got?.paused).toEqual({
      members: ['renamed', 'gamma'],
      queue: [
        { agent: 'renamed', after: ['renamed'] },
        { agent: 'beta', after: ['renamed', 'gamma'] }
      ],
      reasons: { renamed: { kind: 'agent', by: 'gamma' }, beta: { kind: 'agent', by: 'renamed', note: 'n' }, gamma: { kind: 'user' } }
    })
    expect(got?.lost).toEqual({ renamed: ['Search the logs'], beta: ['Read the spec'] })
  })

  it('renameAgent leaves a room with no pause or lost subagents without those keys', async () => {
    const s = mk(),
      group = await s.createGroup(['alpha', 'beta'], '/g', '')
    await s.renameAgent('alpha', 'renamed')
    const got = (await s.get(group.id))?.group
    expect(got && 'paused' in got).toBe(false)
    expect(got && 'lost' in got).toBe(false)
  })

  it('recoverInterrupted clears a compaction the crash cut short', async () => {
    const s = mk(),
      a = await s.create('alpha', '/a')
    await s.update(a.id, { inFlight: true, compacting: true })
    await s.recoverInterrupted()
    expect((await s.get(a.id))?.compacting).toBeUndefined()
  })

  it('recoverInterrupted leaves the versions file untouched', async () => {
    const s = mk(),
      a = await s.create('alpha', '/a')
    const v = versions('alpha')
    await s.saveVersions(a.id, v)
    const path = join(dir, 'chats', `${a.id}.versions.json`)
    const before = await fs.readFile(path, 'utf8')
    await s.update(a.id, { inFlight: true })
    await s.recoverInterrupted()
    expect(await fs.readFile(path, 'utf8')).toBe(before)
    expect(await s.loadVersions(a.id)).toEqual(v)
  })
})

describe('ChatStore items listener', () => {
  it('calls the items listener after a save, not for a removed chat', async () => {
    const s = mk()
    const a = await s.create('alpha', '/a')
    const seen: [string, number][] = []
    s.setItemsListener((id, items) => seen.push([id, items.length]))
    await s.saveItems(a.id, [{ type: 'user', id: 'u', text: 'hi', ts: 1 }])
    expect(seen).toEqual([[a.id, 1]])
    await s.remove(a.id)
    await s.saveItems(a.id, [{ type: 'user', id: 'u', text: 'hi', ts: 1 }])
    expect(seen).toHaveLength(1)
    s.setItemsListener(null)
  })

  it('a throwing items listener neither rejects nor loses the save', async () => {
    const s = mk()
    const a = await s.create('alpha', '/a')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fn = vi.fn(() => {
      throw new Error('boom')
    })
    s.setItemsListener(fn)
    await expect(s.saveItems(a.id, [{ type: 'user', id: 'u', text: 'hi', ts: 1 }])).resolves.toBeUndefined()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(await s.loadItems(a.id)).toHaveLength(1)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('ChatStore board listener', () => {
  const src: TodoSource = { chatId: null, turn: 't1', itemId: null, label: 'Reply', at: 1 }
  const addX = (f: TodoFile): TodoFile => addTodos(f, [{ text: 'x' }], 'user', src, 1, () => 't1').file

  it('tells every write, and none for no change', async () => {
    const s = mk()
    const seen: number[] = []
    s.setBoardListener((f) => seen.push(f.rev))
    await s.updateBoard(addX)
    await s.updateBoard((f) => f)
    expect(seen).toEqual([1])
  })

  it('tells an agent rename that rewrote the board', async () => {
    const s = mk()
    await s.updateBoard((f) => addTodos(f, [{ text: 'x' }], 'alpha', src, 1, () => 't1').file)
    const seen: number[] = []
    s.setBoardListener((f) => seen.push(f.rev))
    await s.renameAgent('alpha', 'beta')
    expect(seen).toEqual([1])
  })

  it('a throwing listener never fails the write, and the file is on disk', async () => {
    const s = mk()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fn = vi.fn(() => {
      throw new Error('boom')
    })
    s.setBoardListener(fn)
    await expect(s.updateBoard(addX)).resolves.toMatchObject({ rev: 1 })
    expect(fn).toHaveBeenCalledTimes(1)
    expect((await mk().loadBoard()).items).toHaveLength(1)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('side questions storage', () => {
  const q = (id: string, agent: string | null = 'alpha'): SideQuestion => ({
    id,
    question: `q ${id}`,
    agent,
    askedAt: 1,
    after: null,
    state: 'done',
    answer: `a ${id}`
  })
  const file = (id: string): string => join(dir, 'chats', `${id}.btw.json`)

  it('saveSide then loadSide round-trips', async () => {
    const s = mk(),
      a = await s.create('alpha', '/a')
    await s.saveSide(a.id, [q('1'), q('2')])
    expect(await mk().loadSide(a.id)).toEqual([q('1'), q('2')])
    expect(JSON.parse(await fs.readFile(file(a.id), 'utf8'))).toMatchObject({ v: 1, items: [{ id: '1' }, { id: '2' }] })
  })

  it('loadSide of a chat with no file is []', async () => {
    const s = mk(),
      a = await s.create('alpha', '/a')
    expect(await s.loadSide(a.id)).toEqual([])
    await expect(s.loadSide('../evil')).rejects.toThrow()
  })

  it('an empty list removes the file', async () => {
    const s = mk(),
      a = await s.create('alpha', '/a')
    await s.saveSide(a.id, [q('1')])
    await s.saveSide(a.id, [])
    expect(existsSync(file(a.id))).toBe(false)
  })

  it('saveSide after remove does not recreate the file', async () => {
    const s = mk(),
      a = await s.create('alpha', '/a')
    await s.remove(a.id)
    await s.saveSide(a.id, [q('1')])
    expect(existsSync(file(a.id))).toBe(false)
  })

  it('remove deletes the btw file', async () => {
    const s = mk(),
      a = await s.create('alpha', '/a')
    await s.saveSide(a.id, [q('1')])
    expect(existsSync(file(a.id))).toBe(true)
    await s.remove(a.id)
    expect(existsSync(file(a.id))).toBe(false)
  })

  it('renameAgent rewrites agent in btw files', async () => {
    const s = mk(),
      a = await s.create('alpha', '/a'),
      b = await s.create('other', '/b')
    await s.saveSide(a.id, [q('1', 'old'), q('2', 'keep'), q('3', null)])
    await s.saveSide(b.id, [q('4', 'keep')])
    await s.renameAgent('old', 'new')
    expect((await s.loadSide(a.id)).map((x) => x.agent)).toEqual(['new', 'keep', null])
    expect(await s.loadSide(b.id)).toEqual([q('4', 'keep')])
  })

  it('renameAgent moves from and asks agent with agent, and leaves other btw files alone', async () => {
    const s = mk(),
      a = await s.create('alpha', '/a'),
      b = await s.create('other', '/b')
    const link = { chatId: 'ab', entryId: 'e', state: 'done' as const }
    await s.saveSide(a.id, [
      {
        ...q('1', 'old'),
        from: 'old',
        asks: [
          { ...link, agent: 'old' },
          { ...link, entryId: 'f', agent: 'keep' }
        ]
      },
      { ...q('2', 'keep'), from: 'old' },
      { ...q('3', 'keep'), asks: [{ ...link, agent: 'old' }] },
      q('4', null)
    ])
    const untouched: SideQuestion[] = [{ ...q('5', 'keep'), from: 'keep', asks: [{ ...link, agent: 'keep' }] }]
    await s.saveSide(b.id, untouched)
    const past = new Date(2000, 0, 1)
    await fs.utimes(file(b.id), past, past)
    await s.renameAgent('old', 'new')
    expect(await s.loadSide(a.id)).toEqual([
      {
        ...q('1', 'new'),
        from: 'new',
        asks: [
          { ...link, agent: 'new' },
          { ...link, entryId: 'f', agent: 'keep' }
        ]
      },
      { ...q('2', 'keep'), from: 'new' },
      { ...q('3', 'keep'), asks: [{ ...link, agent: 'new' }] },
      q('4', null)
    ])
    expect(await s.loadSide(b.id)).toEqual(untouched)
    expect((await fs.stat(file(b.id))).mtimeMs).toBe(past.getTime())
  })

  it('a corrupt btw file is set aside', async () => {
    const s = mk(),
      a = await s.create('alpha', '/a')
    await fs.mkdir(join(dir, 'chats'), { recursive: true })
    await fs.writeFile(file(a.id), '{')
    expect(await s.loadSide(a.id)).toEqual([])
    const baks = (await fs.readdir(join(dir, 'chats'))).filter((f) => f.startsWith(`${a.id}.btw.json.bak-`))
    expect(baks).toHaveLength(1)
  })
})

describe('ChatStore board', () => {
  const legacy = (id: string): string => join(dir, 'chats', `${id}.todos.json`)
  const from = (chatId: string | null = null): TodoSource => ({ chatId, turn: 't1', itemId: null, label: 'Reply', at: 1 })
  const add =
    (by: string, text: string, chatId: string | null = null) =>
    (f: TodoFile): TodoFile =>
      addTodos(f, [{ text }], by, from(chatId), 5, () => `td-${text}`).file

  it('lives in todos.json (0600); a read makes no file, a corrupt one is set aside', async () => {
    const s = mk()
    expect(await s.loadBoard()).toEqual({ v: 1, rev: 0, items: [], seen: {} })
    expect(existsSync(join(dir, 'todos.json'))).toBe(false)
    await s.updateBoard(add('user', 'x'))
    if (process.platform !== 'win32') expect((await fs.stat(join(dir, 'todos.json'))).mode & 0o777).toBe(0o600)
    expect((await s.loadBoard()).items.map((i) => i.text)).toEqual(['x'])
    await fs.writeFile(join(dir, 'todos.json'), '{')
    expect(await s.loadBoard()).toEqual({ v: 1, rev: 0, items: [], seen: {} })
    expect((await fs.readdir(dir)).filter((f) => f.startsWith('todos.json.bak-'))).toHaveLength(1)
  })

  it("a chat's removal keeps the tasks made in it but drops what its sessions had seen", async () => {
    const s = mk(),
      a = await s.create('alpha', '/a'),
      b = await s.create('beta', '/b')
    await s.updateBoard((f) => ({ ...add('alpha', 'made in a', a.id)(f), seen: { [`${a.id}/alpha`]: 1, [`${b.id}/beta`]: 1 } }))
    await fs.mkdir(join(dir, 'chats'), { recursive: true })
    await fs.writeFile(legacy(a.id), '{}')
    await s.remove(a.id)
    const f = await s.loadBoard()
    expect(f.items.map((i) => [i.text, i.from.chatId])).toEqual([['made in a', a.id]])
    expect(f.seen).toEqual({ [`${b.id}/beta`]: 1 })
    expect(existsSync(legacy(a.id))).toBe(false)
  })

  it('renameAgent moves names in items, assignees, tasks, questions and seen keys', async () => {
    const s = mk(),
      a = await s.create('alpha', '/a')
    await s.updateBoard((f) => {
      let g = addTodos(
        f,
        [{ text: 'one' }, { text: 'two' }],
        'old',
        from(a.id),
        5,
        (() => {
          let i = 0
          return () => `i${++i}`
        })()
      ).file
      g = checkTodos(g, ['i1'], true, 'old', 6).file
      g = assignTodo(g, 'i2', 'old', '/w', 7).file
      g = startTask(g, 'i2', { agent: 'old', chatId: 'task', at: 7 }, 7).file
      g = askTodo(g, 'i2', 'task', 'old', [{ text: 'q' }], 8, () => 'q1').file
      return { ...g, seen: { [`${a.id}/old`]: 3, [`${a.id}/keep`]: 2, old: 1 } }
    })
    await s.renameAgent('old', 'new')
    const f = await s.loadBoard()
    const by = (id: string) => f.items.find((i) => i.id === id)!
    expect(by('i1')).toMatchObject({ addedBy: 'new', done: { by: 'new' } })
    expect([by('i2').assignee, by('i2').task?.agent]).toEqual(['new', 'new'])
    expect(by('i2').questions?.[0]?.by).toBe('new')
    expect(f.seen).toEqual({ [`${a.id}/new`]: 3, [`${a.id}/keep`]: 2, new: 1 })
  })

  it('lists the per-chat lists from before the board, and drops them on request', async () => {
    const s = mk(),
      a = await s.create('alpha', '/a')
    await fs.mkdir(join(dir, 'chats'), { recursive: true })
    await fs.writeFile(legacy(a.id), JSON.stringify(add('alpha', 'old item')({ v: 1, rev: 0, items: [], seen: {} })))
    await fs.writeFile(legacy('bad-one'), '{')
    const r = await s.legacyTodoLists()
    expect(r.lists.map((l) => [l.chatId, l.file.items.map((i) => i.text)])).toEqual([[a.id, ['old item']]])
    expect(r.bad).toEqual(['bad-one'])
    await s.dropLegacyTodos([a.id])
    expect(existsSync(legacy(a.id))).toBe(false)
    expect(existsSync(legacy('bad-one'))).toBe(true)
  })
})

describe('ChatStore remote agent thread (agui.json)', () => {
  const file = (id: string): string => join(dir, 'chats', `${id}.agui.json`)
  const thread = { v: 1 as const, threadId: 'th-1', state: { count: 2 }, interrupts: [{ id: 'int-1', expiresAt: null }] }

  it('none yet is null; a save is 0600 and read back; null removes the file', async () => {
    const s = mk(),
      a = await s.create('alpha', '/a')
    expect(await s.loadAgui(a.id)).toBeNull()
    await s.saveAgui(a.id, thread)
    if (process.platform !== 'win32') expect((await fs.stat(file(a.id))).mode & 0o777).toBe(0o600)
    expect(await s.loadAgui(a.id)).toEqual(thread)
    await s.saveAgui(a.id, null)
    expect(existsSync(file(a.id))).toBe(false)
    expect(await s.loadAgui(a.id)).toBeNull()
    // Nothing to remove is no failure.
    await s.saveAgui(a.id, null)
  })

  it('deleting the chat removes its agui.json, and a late save never brings it back', async () => {
    const s = mk(),
      a = await s.create('alpha', '/a')
    await s.saveAgui(a.id, thread)
    await s.remove(a.id)
    expect(existsSync(file(a.id))).toBe(false)
    await expect(s.saveAgui(a.id, thread)).rejects.toThrow(/^Chat not found/)
    expect(existsSync(file(a.id))).toBe(false)
  })

  it('a damaged file reads as no thread yet, so the next run starts a fresh one', async () => {
    const s = mk(),
      a = await s.create('alpha', '/a')
    await fs.mkdir(join(dir, 'chats'), { recursive: true })
    for (const bad of [
      '{',
      '[]',
      JSON.stringify({ v: 2, threadId: 't', interrupts: [] }),
      JSON.stringify({ v: 1, threadId: '', interrupts: [] })
    ]) {
      await fs.writeFile(file(a.id), bad)
      expect(await s.loadAgui(a.id)).toBeNull()
    }
  })

  it('refuses an id that is not a chat id', async () => {
    const s = mk()
    await expect(s.loadAgui('../x')).rejects.toThrow(/Invalid chat id/)
    await expect(s.saveAgui('../x', thread)).rejects.toThrow(/Invalid chat id/)
  })
})

describe('ChatStore dispatched agents', () => {
  const file = (id: string): string => join(dir, 'chats', `${id}.dispatch.json`)
  const entry = (id: string, member?: string): DispatchEntry => ({
    id,
    parent: null,
    turn: 't',
    ...(member ? { member } : {}),
    description: 'd',
    subagentType: null,
    prompt: 'p',
    status: 'done',
    now: null,
    usage: { tokens: null, toolUses: null, durationMs: null },
    steps: [],
    report: null,
    startedAt: 1,
    endedAt: 2,
    updatedAt: 2
  })

  it('dispatch file is 0600, removed with the chat, member renamed', async () => {
    const s = mk(),
      a = await s.create('alpha', '/a')
    expect(await s.loadDispatch(a.id)).toEqual({ v: 1, entries: [] })
    expect(existsSync(file(a.id))).toBe(false)
    await s.updateDispatch(a.id, (f) => ({ ...f, entries: [entry('x', 'old'), entry('y', 'keep')] }))
    if (process.platform !== 'win32') expect((await fs.stat(file(a.id))).mode & 0o777).toBe(0o600)
    await s.renameAgent('old', 'new')
    expect((await s.loadDispatch(a.id)).entries.map((e) => e.member)).toEqual(['new', 'keep'])
    await s.remove(a.id)
    expect(existsSync(file(a.id))).toBe(false)
  })

  it('updateDispatch rejects a removed chat and writes nothing for an unchanged file', async () => {
    const s = mk(),
      a = await s.create('alpha', '/a')
    await s.updateDispatch(a.id, (f) => f)
    expect(existsSync(file(a.id))).toBe(false)
    await s.remove(a.id)
    await expect(s.updateDispatch(a.id, (f) => ({ ...f, entries: [entry('x')] }))).rejects.toThrow(/^Chat not found/)
    expect(existsSync(file(a.id))).toBe(false)
  })

  it('a corrupt dispatch file is set aside', async () => {
    const s = mk(),
      a = await s.create('alpha', '/a')
    await fs.mkdir(join(dir, 'chats'), { recursive: true })
    await fs.writeFile(file(a.id), '{')
    expect(await s.loadDispatch(a.id)).toEqual({ v: 1, entries: [] })
    expect((await fs.readdir(join(dir, 'chats'))).filter((f) => f.startsWith(`${a.id}.dispatch.json.bak-`))).toHaveLength(1)
  })

  it('create and createGroup store the worktree', async () => {
    const s = mk()
    const wt = { root: '/r-a', branch: 'zumibot/a-1', source: '/r', folder: '/r', links: [] }
    const one = await s.create('alpha', '/r-a', { worktree: wt })
    const room = await s.createGroup(['a', 'b'], '/r-a', 'role', { worktree: wt })
    expect((await s.get(one.id))!.worktree).toEqual(wt)
    expect((await s.get(room.id))!.worktree).toEqual(wt)
    expect(await s.create('beta', '/b')).not.toHaveProperty('worktree')
    expect(await s.createGroup(['a'], '/b')).not.toHaveProperty('worktree')
  })
})
