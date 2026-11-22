import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentSummary, ChatItem, ChatMeta, WorkflowLink } from '@zumibot/shared/types'
import { groupKey } from '@zumibot/shared/sidebarLayout'
import {
  NOT_A_ROOM,
  ROOM_NOT_FOUND,
  copyRoom,
  newRoom,
  roomProblem,
  type RoomCopyDeps,
  type RoomTarget
} from '../../src/core/workflows/workflowRooms'
import { ChatStore } from '../../src/core/store/chatStore'
import { SidebarStore } from '../../src/core/store/sidebarStore'

let tmp: string
let store: ChatStore
let copyAllowed: Mock<(from: string, to: string) => void>
let placeRoom: Mock<(chatId: string, sectionId: string) => Promise<void>>
let section: string | null
let agents: AgentSummary[]
let n: number

const agent = (name: string, over: Partial<AgentSummary> = {}): AgentSummary => ({ name, ...over }) as AgentSummary

beforeEach(async () => {
  tmp = await fs.mkdtemp(join(tmpdir(), 'workflow-rooms-'))
  n = 0
  store = new ChatStore(
    join(tmp, 'data'),
    () => 1000,
    () => `c${++n}`
  )
  copyAllowed = vi.fn<(from: string, to: string) => void>()
  placeRoom = vi.fn<(chatId: string, sectionId: string) => Promise<void>>().mockResolvedValue(undefined)
  section = null
  agents = [agent('writer'), agent('critic')]
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

const deps = (): RoomCopyDeps => ({
  store,
  allowed: { copyAllowed },
  agents: async () => agents,
  zumiBot: 'zumi-bot',
  sectionOf: async () => section,
  placeRoom,
  now: () => 5000
})
const link: WorkflowLink = { workflowId: 'w1', runId: 'r1', stepId: 's1', name: 'Flow' }
const target = (room: string, over: Partial<RoomTarget> = {}): RoomTarget => ({
  slotId: 'slot',
  room,
  rules: [],
  title: 'Run room',
  link,
  ...over
})
const items: ChatItem[] = [{ type: 'user', id: 'u1', text: 'hello', ts: 1 }]

async function template(members = ['writer', 'critic']): Promise<ChatMeta> {
  const c = await store.createGroup(members, '/tmp/x', 'R')
  await store.saveItems(c.id, items)
  return store.update(c.id, { title: 'Template' })
}

describe('copyRoom', () => {
  it('copies members, role and folder under the target title, linked to the workflow', async () => {
    const tpl = await template()
    const r = await copyRoom(deps(), target(tpl.id))
    expect('chatId' in r).toBe(true)
    const copy = (await store.get((r as { chatId: string }).chatId))!
    expect(copy.title).toBe('Run room')
    expect(copy.cwd).toBe('/tmp/x')
    expect(copy.group).toMatchObject({ members: ['writer', 'critic'], role: 'R' })
    expect(copy.workflow).toEqual(link)
    expect(copy).not.toHaveProperty('workflowRules')
    expect(await store.loadItems(copy.id)).toEqual([])
  })

  it('a workflow Room step copy of a worktree room runs in the picked folder', async () => {
    const wt = { root: '/r-a', branch: 'zumibot/room-1', source: '/r', folder: '/r/app', links: [] }
    const tpl = await template()
    await store.update(tpl.id, { cwd: '/r-a/app', worktree: wt })
    const r = (await copyRoom(deps(), target(tpl.id))) as { chatId: string }
    const copy = (await store.get(r.chatId))!
    expect(copy.cwd).toBe('/r/app')
    expect(copy).not.toHaveProperty('worktree')
  })

  it('carries the step rules only when there are some', async () => {
    const tpl = await template()
    const rules = [{ tool: 'Bash', command: 'ls' }]
    const r = (await copyRoom(deps(), target(tpl.id, { rules }))) as { chatId: string }
    expect((await store.get(r.chatId))!.workflowRules).toEqual(rules)
  })

  it('leaves the template alone and copies its allowances', async () => {
    const tpl = await template()
    const before = await store.get(tpl.id)
    const r = (await copyRoom(deps(), target(tpl.id))) as { chatId: string }
    expect(await store.get(tpl.id)).toEqual(before)
    expect(await store.loadItems(tpl.id)).toEqual(items)
    expect(copyAllowed).toHaveBeenCalledWith(`${tpl.id}:writer`, `${r.chatId}:writer`)
    expect(copyAllowed).toHaveBeenCalledWith(`${tpl.id}:critic`, `${r.chatId}:critic`)
  })

  it('places the copy in the template room section, and only when it has one', async () => {
    const tpl = await template()
    section = 'S'
    const r = (await copyRoom(deps(), target(tpl.id))) as { chatId: string }
    expect(placeRoom).toHaveBeenCalledWith(r.chatId, 'S')
    placeRoom.mockClear()
    section = null
    await copyRoom(deps(), target(tpl.id))
    expect(placeRoom).not.toHaveBeenCalled()
  })

  it('still succeeds when the placement fails', async () => {
    const tpl = await template()
    section = 'S'
    placeRoom.mockRejectedValue(new Error('disk'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect('chatId' in (await copyRoom(deps(), target(tpl.id)))).toBe(true)
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })

  it('refuses a missing template, a single chat, a missing, broken or Zumi Bot member', async () => {
    expect(await copyRoom(deps(), target('nope'))).toEqual({ error: ROOM_NOT_FOUND })
    const single = await store.create('writer', '/tmp/x')
    expect(await copyRoom(deps(), target(single.id))).toEqual({ error: NOT_A_ROOM })
    const tpl = await template()
    agents = [agent('writer')]
    expect(await copyRoom(deps(), target(tpl.id))).toEqual({ error: 'Agent "critic" not found' })
    agents = [agent('writer'), agent('critic', { error: 'bad' })]
    expect(await copyRoom(deps(), target(tpl.id))).toEqual({ error: 'Agent "critic" has an error' })
    const bot = await template(['writer', 'zumi-bot'])
    expect(await copyRoom(deps(), target(bot.id))).toEqual({ error: "Zumi Bot can't join a group chat" })
  })

  it('makes no room when it refuses', async () => {
    const before = (await store.list()).length
    await copyRoom(deps(), target('nope'))
    expect((await store.list()).length).toBe(before)
  })
})

describe('newRoom', () => {
  const agentsOf = (over: Partial<NonNullable<RoomTarget['agents']>> = {}) => ({
    members: ['writer', 'critic'],
    role: 'Review',
    cwd: '/tmp/y',
    ...over
  })
  const fresh = (over: Partial<RoomTarget> = {}): RoomTarget & { agents: NonNullable<RoomTarget['agents']> } => ({
    ...target('', over),
    agents: agentsOf()
  })

  it('makes a room of those members, role and folder, linked to the workflow with its rules', async () => {
    const rules = [{ tool: 'Bash', command: 'ls' }]
    const r = await newRoom(deps(), { ...fresh(), rules })
    const room = (await store.get((r as { chatId: string }).chatId))!
    expect(room.title).toBe('Run room')
    expect(room.cwd).toBe('/tmp/y')
    expect(room.group).toMatchObject({ members: ['writer', 'critic'], role: 'Review' })
    expect(room.workflow).toEqual(link)
    expect(room.workflowRules).toEqual(rules)
    expect(await store.loadItems(room.id)).toEqual([])
  })

  it('carries no rules key when there are none, and no section when there is none', async () => {
    const r = (await newRoom(deps(), fresh())) as { chatId: string }
    expect(await store.get(r.chatId)).not.toHaveProperty('workflowRules')
    expect(placeRoom).not.toHaveBeenCalled()
  })

  it('puts the room first in the target section, and a failed placement never fails it', async () => {
    const r = (await newRoom(deps(), fresh({ section: 'S' }))) as { chatId: string }
    expect(placeRoom).toHaveBeenCalledWith(r.chatId, 'S')
    placeRoom.mockRejectedValue(new Error('disk'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect('chatId' in (await newRoom(deps(), fresh({ section: 'S' })))).toBe(true)
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })

  it('refuses Zumi Bot, a missing or broken member, and makes no room', async () => {
    const before = (await store.list()).length
    expect(await newRoom(deps(), { ...fresh(), agents: agentsOf({ members: ['writer', 'zumi-bot'] }) })).toEqual({
      error: "Zumi Bot can't join a group chat"
    })
    agents = [agent('writer')]
    expect(await newRoom(deps(), fresh())).toEqual({ error: 'Agent "critic" not found' })
    agents = [agent('writer'), agent('critic', { error: 'bad' })]
    expect(await newRoom(deps(), fresh())).toEqual({ error: 'Agent "critic" has an error' })
    expect((await store.list()).length).toBe(before)
  })

  it('removes the room when marking it fails', async () => {
    const real = store.update.bind(store)
    vi.spyOn(store, 'update').mockImplementation(async (id, patch) => {
      if ('workflow' in patch) throw new Error('disk')
      return real(id, patch)
    })
    await expect(newRoom(deps(), fresh())).rejects.toThrow('disk')
    expect((await store.list()).length).toBe(0)
  })
})

describe('roomProblem', () => {
  it('names the first problem', () => {
    expect(roomProblem(null, [], 'zumi-bot')).toBe(ROOM_NOT_FOUND)
    expect(roomProblem({ id: 'a' } as ChatMeta, [], 'zumi-bot')).toBe(NOT_A_ROOM)
    const room = { id: 'a', group: { members: ['writer', 'critic'] } } as ChatMeta
    expect(roomProblem(room, [agent('writer')], 'zumi-bot')).toBe('Agent "critic" not found')
    expect(roomProblem(room, [agent('writer'), agent('critic')], 'zumi-bot')).toBeNull()
  })
})

describe('SidebarStore.sectionOf', () => {
  it('finds the section holding a key', async () => {
    const s = new SidebarStore(join(tmp, 'side'))
    await s.save({ sections: [{ id: 'S', name: 'S', collapsed: false, items: [groupKey('c1')] }], unassigned: [groupKey('c2')] })
    expect(await s.sectionOf(groupKey('c1'))).toBe('S')
    expect(await s.sectionOf(groupKey('c2'))).toBeNull()
    expect(await s.sectionOf(groupKey('zz'))).toBeNull()
  })
})
