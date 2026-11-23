import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import type { AgentSummary, ChatPush } from '@zumibot/shared/types'
import { AttachmentStore } from '../../src/core/attachments/attachmentStore'
import { ChatStore } from '../../src/core/store/chatStore'
import { TodoService } from '../../src/core/todos/todoService'
import { TaskCards } from '../../src/core/todos/taskCards'
import {
  CONTINUE_MESSAGE,
  TASK_QUESTIONS_DENIED,
  answersMessage,
  commentAsk,
  continueMessage,
  taskMessage,
  taskNote
} from '../../src/core/todos/taskPrompt'
import {
  TODO_COMMENT_MAX,
  cardAskComment,
  cardAskPrompt,
  commentThreads,
  statusOf,
  type CardAsk,
  type TodoComment
} from '@zumibot/shared/todos'
import { bridgeRefusal, commentAskRefusal, engineCaps } from '@zumibot/shared/engine'
import { CommentAsks, finalReply, type CommentAsksDeps } from '../../src/core/todos/commentAsks'
import type { RouteInput, RoutedAsk } from '../../src/core/todos/commentRouting'
import { parseTodoCall } from '../../src/core/todos/todoTools'

let dir: string
let clock: number
let ids: number
let store: ChatStore
let files: AttachmentStore
let changed: number[]
let svc: TodoService
let listChat: string

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0
])
const stage = async (name = 'shot.png'): Promise<string> => {
  const r = await files.stageBytes(name, PNG)
  if (!r.ok) throw new Error(r.error)
  return r.attachment.id
}
const exists = (p: string) =>
  fs.stat(p).then(
    () => true,
    () => false
  )
const item = async (id: string) => (await svc.list(null)).items.find((i) => i.id === id)!

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-cards-'))
  clock = 1000
  ids = 0
  changed = []
  store = new ChatStore(join(dir, 'data'))
  files = new AttachmentStore(join(dir, 'attachments'), () => `f${++ids}`)
  svc = new TodoService({ store, files, now: () => ++clock, newId: () => `t${++ids}`, onChanged: (r) => changed.push(r) })
  listChat = (await store.create('alpha', '/a')).id
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('TodoService card edits', () => {
  it('edits the title and notes, telling tabs with a new rev', async () => {
    await svc.userAdd('Fix login', listChat)
    const id = (await svc.list(null)).items[0]!.id
    changed = []
    await svc.userEdit(id, { text: 'Fix the login page', description: 'It 500s on submit.\nSee logs.' })
    expect(await item(id)).toMatchObject({
      text: 'Fix the login page',
      description: 'It 500s on submit.\nSee logs.',
      last: { action: 'edited', by: 'user' }
    })
    expect(changed).toEqual([2])
  })

  it("moves staged files into the board's folder, and deletes a removed one after the edit is stored", async () => {
    await svc.userAdd('Mine')
    const id = (await svc.list(null)).items[0]!.id
    const a = await stage('a.png'),
      b = await stage('b.png')
    await svc.userEdit(id, { addFiles: [a, b] })
    const stored = (await item(id)).files!
    expect(stored.map((f) => [f.id, f.name, f.kind])).toEqual([
      [a, 'a.png', 'image'],
      [b, 'b.png', 'image']
    ])
    // The board's files live under a folder no chat id can name.
    expect(await exists(files.pathOf('todos', stored[0]!))).toBe(true)
    await svc.userEdit(id, { removeFiles: [a] })
    expect((await item(id)).files!.map((f) => f.id)).toEqual([b])
    expect(await exists(files.pathOf('todos', stored[0]!))).toBe(false)
  })

  it('refuses past ten files before moving any, and takes back the moved ones when the edit fails', async () => {
    await svc.userAdd('X', listChat)
    const id = (await svc.list(null)).items[0]!.id
    const many = await Promise.all(Array.from({ length: 11 }, (_, k) => stage(`${k}.png`)))
    await expect(svc.userEdit(id, { addFiles: many })).rejects.toThrow('at most 10')
    expect(await files.stagedFile(many[0]!)).not.toBeNull() // still staged: nothing moved
    const one = await stage()
    await expect(svc.userEdit(id, { text: ' ', addFiles: [one] })).rejects.toThrow('needs a title')
    expect(await exists(join(dir, 'attachments', 'todos', one))).toBe(false)
  })

  it('refuses an edit of a removed item', async () => {
    await svc.userAdd('X', listChat)
    const id = (await svc.list(null)).items[0]!.id
    await svc.userRemove([id])
    await expect(svc.userEdit(id, { text: 'Y' })).rejects.toThrow('removed')
  })
})

describe('TodoService tasks', () => {
  async function givenCard(list: string | null = listChat, text = 'Build the export'): Promise<{ id: string; taskChat: string }> {
    await svc.userAdd(text, list)
    const id = (await svc.list(null)).items.at(-1)!.id
    await svc.userAssign(id, 'builder', '/b')
    const taskChat = (await store.create('builder', '/b', { task: { todoId: id } })).id
    await svc.userStartTask(id, { agent: 'builder', chatId: taskChat, at: 5 })
    return { id, taskChat }
  }
  const pushMeta = async (chatId: string, inFlight: boolean): Promise<void> => {
    svc.chatPush({ chatId, kind: 'meta', meta: { ...(await store.get(chatId))!, inFlight } })
  }

  it('assigns and starts a card without moving the rev, but tells every tab', async () => {
    await svc.userAdd('Build the export', listChat)
    const id = (await svc.list(null)).items[0]!.id
    changed = []
    expect(await svc.userAssign(id, 'builder', '/b')).toMatchObject({ assignee: 'builder', folder: '/b' })
    expect(statusOf(await item(id))).toBe('new') // assigning starts nothing
    await expect(svc.userStartTask(id, { agent: 'other', chatId: 'c-task', at: 5 })).rejects.toThrow('not assigned to that agent')
    const started = await svc.userStartTask(id, { agent: 'builder', chatId: 'c-task', at: 5 })
    expect([started.task, started.status]).toEqual([{ agent: 'builder', chatId: 'c-task', at: 5, review: null }, 'todo'])
    expect(changed).toEqual([1, 1])
  })

  it('puts the task agent questions on the card, Blocked, and records them for the reply', async () => {
    const { id, taskChat } = await givenCard()
    const text = await svc.agentAskUser(taskChat, 'builder', 'turn-1', [
      { text: 'CSV or JSON?', options: ['CSV', 'JSON'] },
      { text: 'Which folder?' }
    ])
    expect(text).toContain('Put 2 questions on the task card. End your turn now')
    expect((await item(id)).questions!.map((q) => [q.text, q.options, q.by])).toEqual([
      ['CSV or JSON?', ['CSV', 'JSON'], 'builder'],
      ['Which folder?', [], 'builder']
    ])
    expect(statusOf(await item(id))).toBe('blocked')
    expect(svc.touch('turn-1')).toEqual({ added: 0, ticked: [], unticked: [], removed: [], asked: ['CSV or JSON?', 'Which folder?'] })
  })

  it('marks the card In review', async () => {
    const { id, taskChat } = await givenCard(null)
    expect(await svc.agentReview(taskChat, 'builder', 'turn-1', 'Exported to out.csv')).toContain('ready for review')
    expect((await item(id)).task!.review).toEqual({ at: expect.any(Number), summary: 'Exported to out.csv' })
    expect(statusOf(await item(id))).toBe('review')
    expect(svc.touch('turn-1')?.review).toBe(true)
  })

  it("moves the card with its chat's turns: In progress, then Blocked, In review or New; Done stays", async () => {
    const { id, taskChat } = await givenCard()
    await pushMeta(taskChat, true)
    await vi.waitFor(async () => expect(statusOf(await item(id))).toBe('progress'))
    svc.turnEnded({ chatId: taskChat, outcome: 'ok' })
    await vi.waitFor(async () => expect(statusOf(await item(id))).toBe('review')) // ended without a question or review
    await pushMeta(taskChat, false)
    await pushMeta(taskChat, true)
    await vi.waitFor(async () => expect(statusOf(await item(id))).toBe('progress'))
    await svc.agentAskUser(taskChat, 'builder', 't', [{ text: 'A?' }])
    svc.turnEnded({ chatId: taskChat, outcome: 'ok' })
    await vi.waitFor(async () => expect(statusOf(await item(id))).toBe('blocked'))
    await pushMeta(taskChat, true)
    await vi.waitFor(async () => expect(statusOf(await item(id))).toBe('progress'))
    svc.turnEnded({ chatId: taskChat, outcome: 'stopped' })
    await vi.waitFor(async () => expect(statusOf(await item(id))).toBe('blocked')) // its question still waits
    await svc.userAnswer(id, [{ id: (await item(id)).questions![0]!.id, text: 'yes' }])
    await pushMeta(taskChat, true)
    await vi.waitFor(async () => expect(statusOf(await item(id))).toBe('progress'))
    svc.turnEnded({ chatId: taskChat, outcome: 'error' })
    await vi.waitFor(async () => expect(statusOf(await item(id))).toBe('new'))
    await svc.userCheck([id], true)
    await pushMeta(taskChat, true)
    svc.turnEnded({ chatId: taskChat, outcome: 'ok' })
    await new Promise((r) => setTimeout(r, 20))
    expect(statusOf(await item(id))).toBe('done')
  })

  it('tells a plain chat agent it has no card; the chat a card was made in can go, and the task goes on', async () => {
    await expect(svc.agentAskUser(listChat, 'alpha', 't', [{ text: 'q' }])).rejects.toThrow('This chat works on no task card')
    const { id, taskChat } = await givenCard()
    await store.remove(listChat)
    await svc.agentReview(taskChat, 'builder', 't', 's')
    expect((await item(id)).task!.review?.summary).toBe('s')
  })

  it('answers questions and ends a review', async () => {
    const { id, taskChat } = await givenCard()
    await svc.agentReview(taskChat, 'builder', 't1', 'done')
    await svc.agentAskUser(taskChat, 'builder', 't2', [{ text: 'A?' }])
    const q = (await item(id)).questions![0]!
    const r = await svc.userAnswer(id, [{ id: q.id, text: 'yes' }])
    expect(r.answered.map((x) => x.answer?.text)).toEqual(['yes'])
    await svc.agentReview(taskChat, 'builder', 't3', 'done again')
    expect((await svc.userReopen(id)).task!.review).toBeNull()
  })

  it("ends a task chat's message with the card note, and leaves a plain chat's alone", async () => {
    const { id, taskChat } = await givenCard()
    const note = (await svc.note(taskChat, 'builder', { force: false, asked: false })).text
    expect(note).toContain('This chat works on a task card on the user\'s task board in ZumiBot: "Build the export"')
    expect(note).toContain('mcp__zumibot_todos__ask_user')
    await svc.agentAskUser(taskChat, 'builder', 't', [{ text: 'A?' }])
    expect((await svc.note(taskChat, 'builder', { force: false, asked: false })).text).toContain(
      '1 of your questions on the card still wait'
    )
    expect((await svc.note(listChat, 'alpha', { force: false, asked: false })).text).not.toContain('task card')
    await svc.userRemove([id])
    expect((await svc.note(taskChat, 'builder', { force: false, asked: false })).text).toContain('the user removed')
  })

  it("shows a card's notes, creator, assignee and status in the list call, and keeps notes out of the turn note", async () => {
    await svc.agentAdd(listChat, 'alpha', 't', 'L', [{ text: 'Check PR', description: `Look at ${'x'.repeat(400)}` }])
    const list = await svc.agentList(listChat, 'alpha')
    expect(list).toMatch(/- \[t\d+\] Check PR \(by alpha; nobody assigned; New\)\n {2}Notes: Look at x+…/)
    expect((await svc.note(listChat, 'alpha', { force: true, asked: false })).text).not.toContain('Notes:')
  })

  it("assigning the card to the user ends its agent's task: the agent hears the user took it", async () => {
    const { id, taskChat } = await givenCard()
    await svc.agentAskUser(taskChat, 'builder', 't', [{ text: 'A?' }])
    changed = []
    await svc.userAssign(id, 'user', null)
    const taken = await item(id)
    expect(taken.assignee).toBe('user')
    expect('task' in taken || 'questions' in taken || 'folder' in taken).toBe(false)
    expect(statusOf(taken)).toBe('new') // Blocked on the agent's question no more
    expect(changed).toEqual([1]) // every tab hears, the rev stays
    await expect(svc.agentAskUser(taskChat, 'builder', 't', [{ text: 'B?' }])).rejects.toThrow('The user took this task card over')
    await svc.userAssign(id, null, null)
    expect('assignee' in (await item(id))).toBe(false)
    // A done card moved to In progress is unticked and moved in one step.
    await svc.userCheck([id], true)
    await svc.userStatus(id, 'progress')
    expect([(await item(id)).done, statusOf(await item(id))]).toEqual([null, 'progress'])
  })

  it('moves a renamed agent in the assignee, task and questions', async () => {
    // One board: a second card needs a title of its own, or the add is a repeat of an open item.
    const a = await givenCard(listChat, 'Card A')
    const b = await givenCard(null, 'Card B')
    await svc.agentAskUser(a.taskChat, 'builder', 't', [{ text: 'A?' }])
    await svc.agentAskUser(b.taskChat, 'builder', 't', [{ text: 'B?' }])
    await store.renameAgent('builder', 'maker')
    for (const id of [a.id, b.id]) {
      const i = await item(id)
      expect([i.assignee, i.task!.agent, i.questions![0]!.by]).toEqual(['maker', 'maker', 'maker'])
    }
  })
})

describe('TaskCards', () => {
  const agents: AgentSummary[] = [
    { filePath: '/a/builder.md', name: 'builder', description: '', color: null, icon: null, error: null, builtIn: false },
    { filePath: '/a/maker.md', name: 'maker', description: '', color: null, icon: null, error: null, builtIn: false },
    { filePath: '/a/broken.md', name: 'broken', description: '', color: null, icon: null, error: 'bad yaml', builtIn: false },
    { filePath: '', name: 'zumi-bot', description: '', color: null, icon: null, error: null, builtIn: true }
  ]
  let pushes: ChatPush[]
  let sent: [string, string, string[]][]
  let running: Set<string>
  let stopped: string[]
  let cards: TaskCards
  const metas = () => pushes.flatMap((p) => (p.kind === 'meta' ? [p.meta] : []))
  const newCard = async (text = 'X'): Promise<string> => {
    await svc.userAdd(text, listChat)
    return (await svc.list(null)).items.at(-1)!.id
  }
  beforeEach(() => {
    pushes = []
    sent = []
    running = new Set()
    stopped = []
    cards = new TaskCards({
      store,
      todos: svc,
      files,
      submit: async (chatId, text, staged) => {
        sent.push([chatId, text, staged])
      },
      running: (chatId) => running.has(chatId),
      stop: (chatId) => {
        stopped.push(chatId)
      },
      agents: async () => agents,
      isFolder: async (p) => p !== '/missing',
      place: async (_agent, cwd) => ({ cwd: `${cwd}/wt` }),
      rememberFolder: async () => {},
      push: (p) => pushes.push(p),
      now: () => 77
    })
  })

  it('an agent whose engine has no bridges is refused for a card, with the fixed sentence naming it, and the card stays unassigned', async () => {
    const id = await newCard()
    agents.push({
      filePath: '/a/gem.md',
      name: 'gem',
      description: '',
      color: null,
      icon: null,
      error: null,
      builtIn: false,
      provider: 'acp'
    })
    await expect(cards.assign(id, 'gem', '/w')).rejects.toThrow(bridgeRefusal('acp', 'gem'))
    expect((await item(id)).assignee).toBeUndefined()
    // Another engine's agent on the same server, and 'the user', are taken as before.
    await cards.assign(id, 'builder', '/w')
    await cards.assign(id, 'user', null)
    // It reads the cap, not the engine's name.
    const capped = new TaskCards({
      ...(cards as unknown as { d: ConstructorParameters<typeof TaskCards>[0] }).d,
      caps: (e) => ({ ...engineCaps(e), bridges: e !== 'claude' })
    })
    await expect(capped.assign(id, 'builder', '/w')).rejects.toThrow(bridgeRefusal('claude', 'builder'))
    agents.pop()
  })

  it('a card whose agent moved to such an engine since is refused at To do, before a chat is made', async () => {
    const id = await newCard()
    await cards.assign(id, 'maker', '/w')
    const i = agents.findIndex((a) => a.name === 'maker')
    agents[i] = { ...agents[i]!, provider: 'acp' }
    const before = (await store.list()).length
    await expect(cards.move(id, 'todo')).rejects.toThrow(bridgeRefusal('acp', 'maker'))
    expect((await store.list()).length).toBe(before)
    agents[i] = { ...agents[i]!, provider: undefined } as AgentSummary
  })

  it('To do starts the assigned agent in a new chat: linked both ways, titled, its files copied, the card as the first message', async () => {
    const id = await newCard('Design the logo')
    await svc.userEdit(id, { description: 'Blue, round.', addFiles: [await stage('ref.png')] })
    const before = (await store.list()).length
    await cards.assign(id, 'builder', '/work')
    expect([(await store.list()).length, statusOf(await item(id))]).toEqual([before, 'new']) // New: nothing starts
    await cards.move(id, 'todo')
    const [meta] = metas()
    expect(meta).toMatchObject({ agentName: 'builder', cwd: '/work/wt', title: 'Design the logo', task: { todoId: id } })
    expect((await item(id)).task).toEqual({ agent: 'builder', chatId: meta!.id, at: 77, review: null })
    expect(statusOf(await item(id))).toBe('todo')
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    const [chatId, text, staged] = sent[0]!
    expect([chatId, text]).toEqual([meta!.id, 'Task: Design the logo\n\nBlue, round.'])
    // A staged copy, not the card's own file: the chat commits it under its own folder.
    expect(staged).toHaveLength(1)
    expect(staged[0]).not.toBe((await item(id)).files![0]!.id)
    expect(await files.stagedFile(staged[0]!)).not.toBeNull()
  })

  it('shows the card in To do while its chat and worktree are still being made, and puts it back when that fails', async () => {
    let release!: () => void
    let fail = false
    cards = new TaskCards({
      store,
      todos: svc,
      files,
      submit: async (chatId, text, staged) => {
        sent.push([chatId, text, staged])
      },
      running: (chatId) => running.has(chatId),
      stop: (chatId) => {
        stopped.push(chatId)
      },
      agents: async () => agents,
      isFolder: async () => true,
      place: (_agent, cwd) =>
        new Promise((ok, no) => {
          release = () => (fail ? no(new Error('git worktree add failed')) : ok({ cwd: `${cwd}/wt` }))
        }),
      rememberFolder: async () => {},
      push: (p) => pushes.push(p),
      now: () => 77
    })
    const id = await newCard('Slow repo')
    await cards.assign(id, 'builder', '/work')
    const moving = cards.move(id, 'todo')
    // The worktree is still being added: the card is already in To do.
    await vi.waitFor(() => expect(release).toBeDefined())
    expect(statusOf(await item(id))).toBe('todo')
    release()
    await moving
    expect((await item(id)).task?.agent).toBe('builder')

    // A failure puts the card back where it was, so it does not sit in To do with nothing working on it.
    const other = await newCard('Broken repo')
    await cards.assign(other, 'builder', '/work')
    fail = true
    release = undefined as unknown as () => void
    const failing = cards.move(other, 'todo')
    await vi.waitFor(() => expect(release).toBeDefined())
    release()
    await expect(failing).rejects.toThrow('git worktree add failed')
    expect(statusOf(await item(other))).toBe('new')
  })

  it('refuses To do with nobody assigned, and Zumi Bot, a broken or unknown agent or a missing folder, before making any chat', async () => {
    const id = await newCard()
    const before = (await store.list()).length
    await expect(cards.move(id, 'todo')).rejects.toThrow('Assign it to you or an agent first.')
    await expect(cards.move(id, 'progress')).rejects.toThrow('Assign it to you or an agent first.')
    await expect(cards.assign(id, 'zumi-bot', '/w')).rejects.toThrow('Zumi Bot cannot')
    await expect(cards.assign(id, 'broken', '/w')).rejects.toThrow('cannot load')
    await expect(cards.assign(id, 'ghost', '/w')).rejects.toThrow('No agent named ghost')
    await expect(cards.assign(id, 'builder', null)).rejects.toThrow('Pick the folder')
    await expect(cards.assign(id, 'builder', '/missing')).rejects.toThrow('Folder not found')
    expect((await store.list()).length).toBe(before)
    expect('assignee' in (await item(id))).toBe(false)
  })

  it("an agent given a card already in To do starts at once; the user's card only moves", async () => {
    const id = await newCard()
    await cards.assign(id, 'user', null)
    await cards.move(id, 'todo')
    expect([statusOf(await item(id)), metas()]).toEqual(['todo', []])
    await cards.assign(id, 'builder', '/w')
    expect(metas()).toHaveLength(1)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
  })

  it('New and Done stop a running agent; To do again carries on in the same chat', async () => {
    const id = await newCard()
    await cards.assign(id, 'builder', '/w')
    await cards.move(id, 'todo')
    const meta = metas()[0]!
    running.add(meta.id)
    await cards.move(id, 'new')
    expect([stopped, statusOf(await item(id))]).toEqual([[meta.id], 'new'])
    running.delete(meta.id)
    await cards.move(id, 'todo')
    expect(metas()).toHaveLength(1) // no second chat
    await vi.waitFor(() => expect(sent.at(-1)).toEqual([meta.id, CONTINUE_MESSAGE, []]))
    expect(statusOf(await item(id))).toBe('todo')
    running.add(meta.id)
    await cards.move(id, 'done')
    expect([stopped.length, statusOf(await item(id))]).toEqual([2, 'done'])
    // Back while its turn still runs: unticked and In progress, with nothing sent.
    const count = sent.length
    await cards.move(id, 'todo')
    expect([(await item(id)).done, statusOf(await item(id)), sent.length]).toEqual([null, 'progress', count])
    // Blocked and In review only move the card.
    await cards.move(id, 'review')
    expect([statusOf(await item(id)), stopped.length]).toEqual(['review', 2])
  })

  it("giving a working card to another agent stops the old agent's turn and starts the new one", async () => {
    const id = await newCard()
    await cards.assign(id, 'builder', '/w')
    await cards.move(id, 'todo')
    const first = metas()[0]!
    running.add(first.id)
    await cards.assign(id, 'maker', '/m')
    expect(stopped).toEqual([first.id])
    const second = metas()[1]!
    expect(second).toMatchObject({ agentName: 'maker', cwd: '/m/wt' })
    expect((await item(id)).task).toMatchObject({ agent: 'maker', chatId: second.id })
  })

  it('sends answers as one message, and refuses before storing them when the chat is gone', async () => {
    const id = await newCard()
    await cards.assign(id, 'builder', '/w')
    await cards.move(id, 'todo')
    const meta = metas()[0]!
    await svc.agentAskUser(meta.id, 'builder', 't', [{ text: 'Which DB?' }, { text: 'Deadline?' }])
    const [q1, q2] = (await item(id)).questions!
    await cards.answer(id, [{ id: q1!.id, text: 'Postgres' }])
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1]).toEqual([meta.id, 'Answers to your questions on the task card:\n\n> Which DB?\n\nPostgres', []])
    await store.remove(meta.id)
    await expect(cards.answer(id, [{ id: q2!.id, text: 'Friday' }])).rejects.toThrow("task's chat was deleted")
    expect((await item(id)).questions![1]!.answer).toBeNull()
  })

  it('sends a message from the card and ends the review', async () => {
    const id = await newCard()
    await cards.assign(id, 'builder', '/w')
    await cards.move(id, 'todo')
    const meta = metas()[0]!
    await svc.agentReview(meta.id, 'builder', 't', 'done')
    await expect(cards.reply(id, '  ')).rejects.toThrow('Message is empty')
    await cards.reply(id, ' Also add a header row. ')
    expect((await item(id)).task!.review).toBeNull()
    await vi.waitFor(() => expect(sent.at(-1)).toEqual([meta.id, 'Also add a header row.', []]))
  })

  it('refuses answers for a card no agent worked on', async () => {
    const id = await newCard()
    await expect(cards.reply(id, 'hi')).rejects.toThrow('No agent has worked on this to-do yet.')
  })
})

describe('task tools and texts', () => {
  it('parses ask_user and ready_for_review exactly, cutting long text', () => {
    expect(parseTodoCall('ask_user', { questions: [{ question: ' Q? ', options: [' a ', 'b'] }] })).toEqual({
      op: 'ask_user',
      questions: [{ question: 'Q?', options: ['a', 'b'] }]
    })
    expect(parseTodoCall('ask_user', { questions: [{ question: 'x'.repeat(5000) }] })).toMatchObject({
      questions: [{ question: 'x'.repeat(1000) }]
    })
    expect(() => parseTodoCall('ask_user', { questions: [] })).toThrow('questions must be')
    expect(() => parseTodoCall('ask_user', { questions: Array.from({ length: 11 }, () => ({ question: 'q' })) })).toThrow('at most 10')
    expect(() => parseTodoCall('ask_user', { questions: [{ question: 'q', chatId: 'x' }] })).toThrow('each question')
    expect(parseTodoCall('ready_for_review', { summary: ' ok ' })).toEqual({ op: 'ready_for_review', summary: 'ok' })
    expect(() => parseTodoCall('ready_for_review', { summary: 'ok', todoId: 'x' })).toThrow('takes a summary')
    expect(parseTodoCall('add', { items: [{ text: 'a', description: ` ${'d'.repeat(5000)}` }] })).toMatchObject({
      items: [{ text: 'a', description: 'd'.repeat(4000) }]
    })
  })

  it('writes the card, the answers and the note as the agent reads them', () => {
    const comments = [
      { id: 'a', text: 'Look at\nrecord 5', by: 'user', at: 10 },
      { id: 'b', text: '', by: 'user', at: 11, deletedAt: 12 },
      { id: 'c', text: 'On it', by: 'builder', at: 20 },
      { id: 'd', text: 'Also 6', by: 'user', at: 5, editedAt: 30 }
    ]
    expect(taskMessage({ text: 'T', description: 'N', comments })).toBe(
      'Task: T\n\nN\n\nComments on the card:\n\nThe user:\n> Look at\n> record 5\n\nbuilder:\n> On it\n\nThe user (edited):\n> Also 6'
    )
    // Only others' comments written or edited after the last reply.
    expect(continueMessage({ comments }, 'builder', 15)).toBe(
      `${CONTINUE_MESSAGE}\n\nNew comments on the card since your last reply:\n\nThe user (edited):\n> Also 6`
    )
    expect(continueMessage({ comments }, 'builder', 40)).toBe(CONTINUE_MESSAGE)
    const many = Array.from({ length: 5 }, (_, i) => ({ id: `${i}`, text: 'x'.repeat(3000), by: 'user', at: i }))
    const cut = taskMessage({ text: 'T', description: undefined, comments: many })
    expect(cut).toContain('(3 older comments are not shown')
    expect(cut.match(/The user:/g)).toHaveLength(2)
    expect(taskMessage({ text: 'T', description: undefined })).toBe('Task: T')
    expect(answersMessage([{ id: 'q', text: 'Two\nlines?', options: [], by: 'b', at: 1, answer: { text: 'Yes', at: 2 } }])).toBe(
      'Answers to your questions on the task card:\n\n> Two\n> lines?\n\nYes'
    )
    expect(taskNote(null)).toContain('removed')
    expect(TASK_QUESTIONS_DENIED).toContain('mcp__zumibot_todos__ask_user')
  })

  it('splits the mention message around the comment without changing it', () => {
    const c = { id: 'c3', text: 'Fix\nthis @a /card', by: 'user', at: 30 }
    const bare = { id: 't1', text: 'T', description: undefined, comments: [c] }
    const full = {
      id: 't2',
      text: 'Card two',
      description: 'The notes',
      comments: [{ id: 'c1', text: 'first', by: 'user', at: 10 }, { id: 'c2', text: 'second', by: 'a', at: 20 }, c]
    }
    const cmds = [{ name: 'card', prompt: 'Do the card thing' }]
    // The literal text the CLI got before the split (taken from the pre-feature commentAskMessage), so a drift here is caught.
    const tail =
      'Your final message is posted on the card as your reply to this comment, so end with a short answer the user can read there.'
    expect(cardAskPrompt(commentAsk(bare, c, [], 0), c.text)).toBe(
      [
        'The user mentioned you in a comment on the task card "T" (id t1, for the zumibot_todos tools).',
        "The user's comment:",
        '> Fix\n> this @a /card',
        `Do what the comment asks. ${tail}`
      ].join('\n\n')
    )
    expect(cardAskPrompt(commentAsk(full, c, cmds, 2), c.text)).toBe(
      [
        'The user mentioned you in a comment on the task card "Card two" (id t2, for the zumibot_todos tools).',
        "The card's notes:\n\nThe notes",
        "The card's 2 images are attached to this message.",
        'Earlier comments on the card:\n\nThe user:\n> first\n\na:\n> second',
        "The user's comment:\n\n> Fix\n> this @a /card",
        'The comment runs your command /card. Its instructions:\n\nDo the card thing',
        `Do what the comment asks, following those instructions. ${tail}`
      ].join('\n\n')
    )
    const ask = commentAsk(full, c, cmds, 2)
    expect(ask.todoId).toBe('t2')
    expect(ask.title).toBe('Card two')
    expect(ask.before.endsWith("The user's comment:\n\n")).toBe(true)
    expect(ask.after.startsWith('\n\n')).toBe(true)
    expect(ask.after).toContain('Do what the comment asks')
  })
})

describe('CommentAsks', () => {
  const agents: AgentSummary[] = [
    { filePath: '/a/work-assistant.md', name: 'work-assistant', description: '', color: null, icon: null, error: null, builtIn: false },
    { filePath: '/a/broken.md', name: 'broken', description: '', color: null, icon: null, error: 'bad yaml', builtIn: false },
    { filePath: '', name: 'zumi-bot', description: '', color: null, icon: null, error: null, builtIn: true },
    { filePath: '/a/gem.md', name: 'gem', description: '', color: null, icon: null, error: null, builtIn: false, provider: 'acp' },
    { filePath: '/a/rem.md', name: 'rem', description: '', color: null, icon: null, error: null, builtIn: false, provider: 'ag-ui' }
  ]
  let sent: { chatId: string; text: string; prompt: string; cardAsk: CardAsk; messageId: string; files: string[] }[]
  let pushes: ChatPush[]
  let replyWith: string | null
  let asks: CommentAsks
  let base: CommentAsksDeps
  beforeEach(() => {
    sent = []
    pushes = []
    replyWith = 'Made the card: Fix watchers.'
    asks = new CommentAsks(
      (base = {
        store,
        todos: svc,
        files,
        // Plays the turn: the user's message under its id (with the staged files, as a send commits them), then the agent's messages.
        submit: async (chatId, text, messageId, staged, cardAsk) => {
          const attachments = await files.commit(chatId, staged)
          const prompt = cardAskPrompt(cardAsk, cardAskComment(cardAsk, text))
          sent.push({ chatId, text, prompt, cardAsk, messageId, files: attachments.map((a) => a.name) })
          const items = await store.loadItems(chatId)
          const turn = [
            { type: 'user' as const, id: messageId, text, cardAsk, ts: 1, ...(attachments.length > 0 ? { attachments } : {}) },
            { type: 'assistant' as const, id: `a${messageId}`, text: 'Looking…', ts: 2 }
          ]
          if (replyWith !== null) turn.push({ type: 'assistant' as const, id: `b${messageId}`, text: replyWith, ts: 3 })
          await store.saveItems(chatId, [...items, ...turn])
        },
        agents: async () => agents,
        commandsOf: async (a) =>
          a === 'work-assistant' ? [{ name: 'card', description: 'Make a card', prompt: 'Create a card for: $ARGUMENTS' }] : [],
        isFolder: async (p) => p === '/a',
        place: async (_agent, cwd) => ({ cwd }),
        lastFolder: async () => null,
        home: '/home/me',
        push: (p) => pushes.push(p),
        newId: () => `m${++ids}`
      })
    )
  })
  const card = async (): Promise<string> => {
    await svc.userAdd('Investigate watchers', listChat)
    return (await svc.list(null)).items.at(-1)!.id
  }

  describe('routing', () => {
    const writer: AgentSummary = {
      filePath: '/a/writer.md',
      name: 'writer',
      description: 'Writes notes.',
      color: null,
      icon: null,
      error: null,
      builtIn: false
    }
    let inputs: RouteInput[]
    let recorded: string[]
    const routed = (answer: (input: RouteInput) => RoutedAsk[] | null | Promise<RoutedAsk[] | null>): CommentAsks =>
      new CommentAsks({
        ...base,
        route: async (input) => {
          inputs.push(input)
          const asks = await answer(input)
          return asks === null ? null : { asks, record: (chatId) => recorded.push(chatId) }
        }
      })
    beforeEach(() => {
      agents.push(writer)
      inputs = []
      recorded = []
    })
    afterEach(() => {
      agents.splice(agents.indexOf(writer), 1)
    })

    // The routing call held open until `go` is called, so a test sees the comment while it picks.
    const held = (): { answer: () => Promise<RoutedAsk[] | null>; go(asks: RoutedAsk[] | null): void } => {
      let go!: (asks: RoutedAsk[] | null) => void
      const gate = new Promise<RoutedAsk[] | null>((r) => (go = r))
      return { answer: () => gate, go }
    }
    const routingOf = async (id: string, n = 0) => (await item(id)).comments![n]!.routing

    it('stores the comment at once, picking, and fills in who it asks when the routing call answers', async () => {
      const id = await card()
      const h = held()
      await routed(h.answer).comment(id, '@work-assistant and @writer look', null)
      expect((await item(id)).comments![0]).toMatchObject({ text: '@work-assistant and @writer look', routing: true })
      expect((await item(id)).comments![0]).not.toHaveProperty('asked')
      expect(sent).toEqual([])
      h.go([{ agent: 'writer', message: 'Look at this card.' }])
      await vi.waitFor(async () => expect(await routingOf(id)).toBeUndefined())
      expect((await item(id)).comments![0]!.asked).toEqual(['writer'])
      await vi.waitFor(() => expect(sent).toHaveLength(1))
      expect(sent[0]!.text).toBe('Look at this card.')
    })

    it('asks nobody for a comment deleted while it was picking', async () => {
      const id = await card()
      const h = held()
      const done = vi.spyOn(svc, 'commentRouted')
      await routed(h.answer).comment(id, '@writer look', null)
      const c = (await item(id)).comments![0]!
      await svc.userDeleteComment(id, c.id)
      h.go([{ agent: 'writer', message: 'Look.' }])
      await vi.waitFor(() => expect(done).toHaveBeenCalled())
      await expect(done.mock.results[0]!.value).resolves.toBeNull()
      expect(sent).toEqual([])
      expect((await item(id)).comments![0]).not.toHaveProperty('asked')
    })

    it('shows the comment as it is now, not the line, when it was edited while picking', async () => {
      const id = await card()
      const h = held()
      await routed(h.answer).comment(id, '@writer look', null)
      const c = (await item(id)).comments![0]!
      await svc.userEditComment(id, c.id, '@writer look again')
      h.go([{ agent: 'writer', message: 'Look.' }])
      await vi.waitFor(() => expect(sent).toHaveLength(1))
      expect(sent[0]!.text).toBe('@writer look again')
      expect(sent[0]!.cardAsk).not.toHaveProperty('comment')
      expect(recorded).toEqual([sent[0]!.chatId])
    })

    it('asks only the addressed agent, shows the line written for it, and the agent still reads the comment as written', async () => {
      const id = await card()
      const text = '@work-assistant Can you ask @writer to check if we have a card for this?'
      await routed(() => [{ agent: 'work-assistant', message: 'Ask @writer to check whether we have a card for this.' }]).comment(
        id,
        text,
        null
      )
      await vi.waitFor(async () => expect((await item(id)).comments![0]).toMatchObject({ text, asked: ['work-assistant'] }))
      await vi.waitFor(async () => expect((await item(id)).comments).toHaveLength(2))
      expect(sent).toHaveLength(1)
      expect(sent[0]!.text).toBe('Ask @writer to check whether we have a card for this.')
      expect(sent[0]!.cardAsk.comment).toBe(text)
      expect(sent[0]!.prompt).toContain(`> ${text}`)
      expect(recorded).toEqual([sent[0]!.chatId])
      expect(inputs[0]).toEqual({
        card: 'Investigate watchers',
        comment: text,
        thread: null,
        candidates: [
          { name: 'work-assistant', description: '' },
          { name: 'writer', description: 'Writes notes.' }
        ]
      })
    })

    it('asks nobody when the comment is addressed to nobody', async () => {
      const id = await card()
      await routed(() => []).comment(id, 'Thanks @work-assistant!', null)
      await vi.waitFor(async () => expect(await routingOf(id)).toBeUndefined())
      expect((await item(id)).comments![0]!.asked).toBeUndefined()
      expect(sent).toEqual([])
    })

    it('asks every agent the comment names, with the comment as written, when routing gives no answer or fails', async () => {
      const id = await card()
      await routed(() => null).comment(id, '@work-assistant and @writer look', null)
      await vi.waitFor(async () => expect((await item(id)).comments![0]!.asked).toEqual(['work-assistant', 'writer']))
      await vi.waitFor(() => expect(sent).toHaveLength(2))
      expect(sent.map((s) => s.text)).toEqual(['@work-assistant and @writer look', '@work-assistant and @writer look'])
      expect(sent[0]!.cardAsk).not.toHaveProperty('comment')
      await routed(() => Promise.reject(new Error('boom'))).comment(id, '@writer again', null)
      await vi.waitFor(async () => expect((await item(id)).comments!.find((c) => c.text === '@writer again')!.asked).toEqual(['writer']))
      await vi.waitFor(() => expect(sent).toHaveLength(3))
    })

    it("gives a reply's routing the thread's first comment", async () => {
      const id = await card()
      await routed(() => null).comment(id, '@work-assistant draft the mail', null)
      await vi.waitFor(async () => expect((await item(id)).comments).toHaveLength(2))
      const answer = (await item(id)).comments![1]!
      await routed(() => [{ agent: 'work-assistant', message: 'Send the mail.' }]).comment(id, 'send', answer.id)
      expect(inputs[1]).toMatchObject({ comment: 'send', thread: '@work-assistant draft the mail' })
      await vi.waitFor(() => expect(sent).toHaveLength(2))
      expect(sent[1]!.text).toBe('Send the mail.')
    })
  })

  it('runs a mentioned agent in a chat for the card, in the folder the card came from, and posts its last message under the comment', async () => {
    const id = await card()
    await asks.comment(id, 'Hey @Work-Assistant create a card for this, @broken and @zumi-bot too', null)
    const [asked] = (await item(id)).comments!
    expect(asked).toMatchObject({ by: 'user', asked: ['work-assistant'] })
    await vi.waitFor(async () => expect((await item(id)).comments).toHaveLength(2))
    const reply = (await item(id)).comments![1]!
    expect(reply).toMatchObject({ by: 'work-assistant', replyTo: asked!.id, text: 'Made the card: Fix watchers.' })
    const meta = pushes.flatMap((p) => (p.kind === 'meta' ? [p.meta] : []))[0]!
    expect(meta).toMatchObject({ agentName: 'work-assistant', cwd: '/a', cardComments: { todoId: id } })
    expect(sent[0]!.text).toBe('Hey @Work-Assistant create a card for this, @broken and @zumi-bot too')
    expect(sent[0]!.cardAsk).toMatchObject({ todoId: id, title: 'Investigate watchers' })
    expect(sent[0]!.prompt).toContain(`id ${id}`)
    expect(sent[0]!.prompt).toContain('> Hey @Work-Assistant create a card')
  })

  it("sends the card's images with a mention, each once: a later mention carries only an image added since", async () => {
    const id = await card()
    await svc.userEdit(id, { addFiles: [await stage('shot.png')] })
    await asks.comment(id, '@work-assistant look at this', null)
    await vi.waitFor(async () => expect((await item(id)).comments).toHaveLength(2))
    expect(sent[0]!.files).toEqual(['shot.png'])
    expect(sent[0]!.prompt).toContain("The card's image is attached to this message.")
    await svc.userEdit(id, { addFiles: [await stage('later.png')] })
    await asks.comment(id, '@work-assistant and now?', null)
    await vi.waitFor(async () => expect((await item(id)).comments).toHaveLength(4))
    expect(sent[1]!.files).toEqual(['later.png'])
    await asks.comment(id, '@work-assistant once more', null)
    await vi.waitFor(async () => expect((await item(id)).comments).toHaveLength(6))
    expect(sent[2]!.files).toEqual([])
    expect(sent[2]!.prompt).not.toContain('attached to this message')
  })

  it('reuses the same chat for a later mention and threads a reply to a reply under the top comment', async () => {
    const id = await card()
    await asks.comment(id, '@work-assistant first', null)
    await vi.waitFor(async () => expect((await item(id)).comments).toHaveLength(2))
    const top = (await item(id)).comments![0]!
    await asks.comment(id, '@work-assistant and again', (await item(id)).comments![1]!.id)
    await vi.waitFor(async () => expect((await item(id)).comments).toHaveLength(4))
    expect(new Set(sent.map((s) => s.chatId)).size).toBe(1)
    expect((await item(id)).comments!.slice(1).map((c) => c.replyTo)).toEqual([top.id, top.id, top.id])
  })

  it('refuses, before storing the comment, a mention of an ACP or remote agent: neither has the to-do tools a card chat needs', async () => {
    const id = await card()
    await expect(asks.comment(id, '@work-assistant and @gem please look', null)).rejects.toThrow(commentAskRefusal('acp', 'gem'))
    await expect(asks.comment(id, '@rem please look', null)).rejects.toThrow(commentAskRefusal('ag-ui', 'rem'))
    expect((await item(id)).comments ?? []).toEqual([])
    expect(sent).toEqual([])
  })

  it("a reply with no mention goes on with the thread's agent; one that names another asks only that one", async () => {
    agents.push({ filePath: '/a/writer.md', name: 'writer', description: '', color: null, icon: null, error: null, builtIn: false })
    try {
      const id = await card()
      await asks.comment(id, '@work-assistant set up the meeting', null)
      await vi.waitFor(async () => expect((await item(id)).comments).toHaveLength(2))
      const answer = (await item(id)).comments![1]!
      await asks.comment(id, 'send', answer.id)
      expect((await item(id)).comments![2]).toMatchObject({ text: 'send', asked: ['work-assistant'] })
      await vi.waitFor(async () => expect((await item(id)).comments).toHaveLength(4))
      await asks.comment(id, '@writer draft the notes', answer.id)
      expect((await item(id)).comments![4]).toMatchObject({ asked: ['writer'] })
      await vi.waitFor(async () => expect((await item(id)).comments).toHaveLength(6))
      // A thread now holding both: a plain reply asks the one who answered last first, and both.
      await asks.comment(id, 'thanks both', answer.id)
      expect((await item(id)).comments![6]!.asked).toEqual(['writer', 'work-assistant'])
      await vi.waitFor(async () => expect((await item(id)).comments).toHaveLength(9))
    } finally {
      agents.pop()
    }
  })

  it('a plain reply leaves out a thread agent that has lost the to-do tools since (moved to ACP): it is never asked', async () => {
    const id = await card()
    await asks.comment(id, '@work-assistant set up the meeting', null)
    await vi.waitFor(async () => expect((await item(id)).comments).toHaveLength(2))
    const answer = (await item(id)).comments![1]!
    const at = agents.findIndex((a) => a.name === 'work-assistant')
    const was = agents[at]!
    agents[at] = { ...was, provider: 'acp' }
    try {
      const before = sent.length
      await asks.comment(id, 'send', answer.id)
      expect((await item(id)).comments![2]).toMatchObject({ text: 'send' })
      expect((await item(id)).comments![2]!.asked).toBeUndefined()
      expect(sent).toHaveLength(before)
    } finally {
      agents[at] = was
    }
  })

  it('sends the saved prompt of a /command the mentioned agent owns, filled with the rest of the comment', async () => {
    const id = await card()
    await asks.comment(id, '@work-assistant /card fix the login', null)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]!.prompt).toContain('The comment runs your command /card. Its instructions:\n\nCreate a card for: fix the login')
  })

  it('posts nothing when the turn wrote no message, and a plain comment runs nobody', async () => {
    const id = await card()
    replyWith = null
    sent = []
    await asks.comment(id, 'no mention here, mail me@work-assistant.com', null)
    expect(sent).toEqual([])
    expect((await item(id)).comments![0]!.asked).toBeUndefined()
  })
})

describe('comment threads', () => {
  it('groups replies under their top comment and keeps a deleted one only while it has replies', () => {
    const c = (id: string, o: Partial<TodoComment> = {}): TodoComment => ({ id, text: id, by: 'user', at: 1, ...o })
    const threads = commentThreads({
      comments: [
        c('a'),
        c('b', { deletedAt: 2, text: '' }),
        c('r1', { replyTo: 'a' }),
        c('d', { deletedAt: 3, text: '' }),
        c('r2', { replyTo: 'd' })
      ]
    })
    expect(threads.map((t) => [t.comment.id, t.replies.map((r) => r.id)])).toEqual([
      ['a', ['r1']],
      ['d', ['r2']]
    ])
  })

  it('cuts a long final reply to fit a comment, and takes the last message before the next user message', () => {
    const long = 'x'.repeat(TODO_COMMENT_MAX + 50)
    const cut = finalReply(
      [
        { type: 'user', id: 'm', text: '' },
        { type: 'assistant', id: 'a', text: long }
      ],
      'm'
    )!
    expect(cut.length).toBeLessThanOrEqual(TODO_COMMENT_MAX)
    expect(cut.endsWith('(the rest is in the chat)')).toBe(true)
    expect(
      finalReply(
        [
          { type: 'user', id: 'm' },
          { type: 'assistant', id: 'a', text: 'mine' },
          { type: 'user', id: 'n' },
          { type: 'assistant', id: 'b', text: 'later' }
        ],
        'm'
      )
    ).toBe('mine')
    expect(finalReply([{ type: 'user', id: 'x' }], 'm')).toBeNull()
  })
})
