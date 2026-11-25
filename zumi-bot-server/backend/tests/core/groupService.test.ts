import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, promises as fs, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AttachmentStore } from '../../src/core/attachments/attachmentStore'
import { ChatStore } from '../../src/core/store/chatStore'
import { ChatService, NOTHING_TO_COMPACT, type ChatServiceDeps } from '../../src/core/chat/chatService'
import type { BrowserHandoff, BrowserOwner } from '../../src/core/browser/types'
import { HOUSE_STYLE } from '../../src/core/chat/houseStyle'
import { TODO_REQUEST, TODO_SYSTEM } from '../../src/core/todos/todoPrompt'
import { RUN_SYSTEM } from '../../src/core/processes/processPrompt'
import { TodoService } from '../../src/core/todos/todoService'
import { DispatchService } from '../../src/core/dispatch/dispatchService'
import { lostNote } from '@zumibot/shared/pause'
import { runResultText } from '@zumibot/shared/runBlocks'
import { GroupService } from '../../src/core/chat/groupService'
import { TaskQueue, type TaskQueueDeps } from '../../src/core/chat/taskQueue'
import { ChatTmp } from '../../src/core/chat/chatTmp'
import { pauseSettings } from '../../src/core/chat/pauseSettings'
import type { RoomTurnEnd } from '../../src/core/chat/readMarks'
import { refsOf, withNote } from '../../src/core/attachments/content'
import { SEED_MAX_CHARS, buildSeedPrompt } from '../../src/core/chat/seedPrompt'
import type { ModeratorAnswer } from '../../src/core/chat/groupQueue'
import type { ModeratorInput } from '../../src/core/chat/moderator'
import type { RunEvent } from '../../src/core/chat/streamParser'
import { ruleOf, type UserContent } from '../../src/core/chat/controlProtocol'
import type { RunHandle, RunOptions, RunOutcome } from '../../src/core/chat/claudeRunner'
import { displayName } from '@zumibot/shared/frontmatter'
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import { CODEX_REFUSALS, engineCaps, todoRefusal, unguardedNoticeText, type Engine, type EngineCaps } from '@zumibot/shared/engine'
import {
  PASS_MARKER,
  ROLE_MAX_CHARS,
  type AgentRule,
  type AgentSummary,
  type Attachment,
  type ChatItem,
  type ChatMeta,
  type ChatPush,
  type GroupInfo
} from '@zumibot/shared/types'
import { NO_MCP, type McpServerSpec } from '../../src/core/ipc/mcpSpec'
import { runCodex, type CodexRunOptions } from '../../src/core/codex/codexRunner'
import { startAcp, type AcpRunOptions } from '../../src/core/acp/acpRunner'
import { acpRecord, LaunchTrust } from '../../src/core/acp/launchTrust'
import type { AcpLaunch } from '@zumibot/shared/acp'
import { codexPauseHook, codexVaultHooks } from '../../src/core/codex/codexHooks'
import { buildBriefing } from '../../src/core/chat/groupPrompts'
import { workflowSystem } from '../../src/core/workflows/workflowPrompt'
import { writeFakeBin } from '../support/fakeBin'

// stubborn: Stop does not end the run, only finish() does, like a CLI slow to wind down
interface Script {
  text?: string
  events?: RunEvent[]
  outcome?: Partial<RunOutcome>
  hang?: boolean
  stubborn?: boolean
}
interface Live {
  finish(): void
  emit(e: RunEvent): void
}
type ModAnswer = ModeratorAnswer | null | 'hang' | Promise<ModeratorAnswer | null>
const par = (...names: string[]): ModeratorAnswer => ({
  next: names.map((agent) => ({ agent, after: [], note: null })),
  drop: [],
  skip: [],
  askUser: false
})
const seq = (...names: string[]): ModeratorAnswer => ({
  next: names.map((agent, i) => ({ agent, after: i > 0 ? [names[i - 1]] : [], note: null })),
  drop: [],
  skip: [],
  askUser: false
})
const none = (): ModeratorAnswer => ({ next: [], drop: [], skip: [], askUser: false })
const pick = (agent: string, after: string[] = [], note: string | null = null) => ({ agent, after, note })
const q = {
  questions: [
    {
      question: 'Which?',
      header: 'W',
      options: [
        { label: 'Yes', description: '' },
        { label: 'No', description: '' }
      ]
    }
  ]
}

const okResult: RunEvent = {
  kind: 'result',
  subtype: 'success',
  isError: false,
  numTurns: 1,
  sessionId: 's',
  denials: [],
  windows: {},
  uuid: null,
  cost: null
}
const baseOutcome = (o: Partial<RunOutcome> = {}): RunOutcome => ({
  exitCode: 0,
  signal: null,
  stderr: '',
  spawnError: null,
  result: okResult as RunOutcome['result'],
  stopped: false,
  ...o
})
const replyEvents = (agent: string, text: string): RunEvent[] => [
  { kind: 'init', sessionId: `s-${agent}` },
  { kind: 'textDelta', text },
  { kind: 'assistantText', text },
  okResult
]
const agentSummary = (name: string, builtIn = false): AgentSummary => ({
  filePath: `/agents/${name}.md`,
  name,
  description: `${name} role`,
  color: null,
  icon: null,
  error: null,
  builtIn
})

let dir: string
let store: ChatStore
let chats: ChatService
let chatDeps: ChatServiceDeps
let files: AttachmentStore
let svc: GroupService
// stdin is the text of what the CLI was sent (the text block of a block list); raw is the content as sent.
type TextRun = Omit<RunOptions, 'stdin'> & { stdin: string; raw: UserContent }
let calls: TextRun[]
let live: Live[]
let scripts: Record<string, Script[]>
let fallback: (agent: string) => Script
let pushes: ChatPush[]
let agentList: AgentSummary[]
let modAnswers: ModAnswer[]
let modFallback: (input: ModeratorInput) => ModAnswer
let modInputs: ModeratorInput[]
let modChatIds: string[]
let modSignals: AbortSignal[]
let deny: (name: string) => string[]
let style: boolean
let n: number
let idled: string[]
let ruleAdds: [string, AgentRule][]
let roomEnds: RoomTurnEnd[]
let onRoomEnd: (e: RoomTurnEnd) => void

const textOf = (c: UserContent): string => {
  if (typeof c === 'string') return c
  const first = c[0]
  return first?.type === 'text' ? first.text : ''
}

const fakeRun = (o: RunOptions): RunHandle => {
  const raw = o.stdin as UserContent
  if (typeof raw !== 'string') expect(raw[0]).toMatchObject({ type: 'text' })
  calls.push({ ...o, stdin: textOf(raw), raw })
  const agent = o.args[2]
  const s = scripts[agent]?.shift() ?? fallback(agent)
  const events = s.events ?? replyEvents(agent, s.text ?? `${agent} done`)
  let resolveDone: (x: RunOutcome) => void = () => {}
  const done = new Promise<RunOutcome>((resolve) => {
    resolveDone = resolve
  })
  let ended = false
  const end = (x: RunOutcome) => {
    if (!ended) {
      ended = true
      resolveDone(x)
    }
  }
  const finish = () => {
    events.forEach((e) => o.onEvent(e))
    end(baseOutcome(s.outcome))
  }
  live.push({ finish, emit: (e) => o.onEvent(e) })
  if (!s.hang) setImmediate(finish)
  return {
    stop: () => {
      if (!s.stubborn) end(baseOutcome({ exitCode: null, signal: 'SIGINT', result: null, stopped: true }))
    },
    send: () => true,
    done
  }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-group-'))
  calls = []
  live = []
  scripts = {}
  fallback = (agent) => ({ text: `${agent} done` })
  pushes = []
  agentList = ['ui', 'wk', 'ps'].map((a) => agentSummary(a)).concat(agentSummary(ZUMI_BOT_NAME, true))
  modAnswers = []
  modFallback = () => none()
  modInputs = []
  modChatIds = []
  modSignals = []
  deny = () => []
  style = false
  n = 0
  idled = []
  ruleAdds = []
  roomEnds = []
  onRoomEnd = (e) => {
    roomEnds.push(e)
  }
  store = new ChatStore(dir)
  files = new AttachmentStore(join(dir, 'attachments'), () => 'unused')
  chats = new ChatService(
    (chatDeps = {
      store,
      files,
      locate: async () => '/bin/claude',
      run: fakeRun,
      // This claude takes --resume-drops-turn, so a member's cut can declare the turn it discards where one is stamped.
      dropsTurn: async () => true,
      push: (p) => pushes.push(p),
      now: () => 1000 + n,
      newId: () => `x${++n}`,
      permissionMode: 'auto',
      disallowedToolsFor: (a) => deny(a),
      houseStyle: async () => style,
      agentRules: {
        cli: () => [],
        addCli: async () => {},
        has: (agent, key) => agent === 'ui' && key === ruleOf('Bash', { command: 'ls' }).key,
        add: (agent, rule) => {
          ruleAdds.push([agent, rule])
        }
      },
      onIdle: (id) => idled.push(id)
    })
  )
  svc = new GroupService({
    store,
    chats,
    files,
    agents: async () => agentList,
    moderate: async (input, _cwd, signal, chatId) => {
      modChatIds.push(chatId)
      modInputs.push(input)
      modSignals.push(signal)
      const a = modAnswers.length > 0 ? modAnswers.shift()! : modFallback(input)
      if (a === 'hang') return new Promise<ModeratorAnswer | null>(() => {})
      return a
    },
    push: (p) => pushes.push(p),
    now: () => 1000 + n,
    newId: () => `x${++n}`,
    disallowedToolsFor: (a) => deny(a),
    onTurnEnd: (e) => onRoomEnd(e)
  })
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (cond: () => boolean, what = 'condition') => {
  for (let i = 0; i < 1000 && !cond(); i++) await sleep(2)
  if (!cond()) throw new Error(`timed out waiting for ${what}`)
}
const idle = (id: string) => until(() => !chats.isRunning(id), 'the room to go idle')
const agentOf = (o: RunOptions) => o.args[2]
const metaOf = async (id: string) => (await store.get(id)) as ChatMeta & { group: NonNullable<ChatMeta['group']> }
const assistants = (items: ChatItem[]) => items.filter((i): i is Extract<ChatItem, { type: 'assistant' }> => i.type === 'assistant')
const group = (members = ['ui', 'wk', 'ps']) => store.createGroup(members, dir)
const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1]
// A later probe turning Codex rooms off: every Phase 2 room refusal comes back.
const noCodexRooms = (e: Engine): EngineCaps => ({ ...engineCaps(e), ...(e === 'codex' ? { rooms: false } : {}) })

describe('GroupService side questions', () => {
  it('sideThread of an idle member starts after its seen item', async () => {
    const c = await group()
    await store.saveItems(c.id, [
      { type: 'user', id: 'u0', text: 'already read', ts: 1 },
      { type: 'assistant', id: 'a0', text: 'also read', agent: 'wk', ts: 2 },
      { type: 'user', id: 'u1', text: 'new request', ts: 3 },
      { type: 'assistant', id: 'a1', text: 'new reply', agent: 'wk', ts: 4 },
      { type: 'assistant', id: 'a2', text: 'own reply', agent: 'ui', ts: 5 }
    ])
    await store.updateGroup(c.id, (g) => ({ ...g, seen: { ui: 'a0' } }))

    expect(await svc.sideThread(c.id, 'ui')).toEqual([
      { from: null, text: 'new request' },
      { from: 'wk', text: 'new reply' }
    ])
    expect(await svc.sideThread(c.id, 'ps')).toEqual([
      { from: null, text: 'already read' },
      { from: 'wk', text: 'also read' },
      { from: null, text: 'new request' },
      { from: 'wk', text: 'new reply' },
      { from: 'ui', text: 'own reply' }
    ])
  })

  it("sideThread of a working member starts after its turn's start and includes another member's live text", async () => {
    const c = await group()
    await store.saveItems(c.id, [{ type: 'user', id: 'u0', text: 'old request', ts: 1 }])
    await store.updateGroup(c.id, (g) => ({ ...g, seen: { ui: 'u0' } }))
    modAnswers = [par('ui', 'wk')]
    scripts.ui = [{ hang: true }]
    scripts.wk = [{ hang: true }]
    await svc.send(c.id, '@ui @wk go')
    await until(() => calls.length === 2, 'both members to start')
    try {
      live[0].emit({ kind: 'assistantText', text: 'ui partial' })
      live[1].emit({ kind: 'assistantText', text: 'wk partial' })
      await svc.send(c.id, 'new request while working')

      expect(await svc.sideThread(c.id, 'ui')).toEqual([
        { from: 'wk', text: 'wk partial' },
        { from: null, text: 'new request while working' }
      ])
    } finally {
      live.forEach((l) => l.finish())
      await idle(c.id)
    }
  })

  it('pickInput lists working members', async () => {
    const c = await group()
    agentList = agentList.filter((a) => a.name !== 'ps').concat({ ...agentSummary('ps'), error: 'broken agent' })
    modAnswers = [par('ui', 'wk')]
    scripts.ui = [{ hang: true }]
    scripts.wk = [{ hang: true }]
    await svc.send(c.id, '@ui @wk go')
    await until(() => calls.length === 2, 'both members to start')
    try {
      live[1].emit({ kind: 'assistantText', text: 'wk partial' })
      expect(await svc.pickInput(c.id, 'Who is implementing this?')).toEqual({
        members: [
          { name: 'ui', description: 'ui role' },
          { name: 'wk', description: 'wk role' }
        ],
        messages: [
          { from: null, text: '@ui @wk go' },
          { from: 'wk', text: 'wk partial' }
        ],
        working: ['ui', 'wk'],
        question: 'Who is implementing this?'
      })
    } finally {
      live.forEach((l) => l.finish())
      await idle(c.id)
    }

    expect((await svc.pickInput(c.id, 'What happened?')).working).toEqual([])
  })
})

describe('GroupService onIdle', () => {
  it('onIdle fires once when the room ends', async () => {
    const c = await group()
    modAnswers = [par('wk'), none()]
    await svc.send(c.id, 'hi')
    await idle(c.id)
    expect(idled).toEqual([c.id])
  })
})

describe('GroupService attachments', () => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
  const img: Attachment = { id: 'a1', name: 'pic.png', mime: 'image/png', size: PNG.length, kind: 'image' }
  const write = async (chatId: string, atts: Attachment[]) => {
    for (const a of atts) {
      await fs.mkdir(join(files.dirOf(chatId), a.id), { recursive: true })
      await fs.writeFile(files.pathOf(chatId, a), PNG)
    }
  }
  const imageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } }

  it('posts a message with attachments and no text', async () => {
    const c = await group()
    await write(c.id, [img])
    modAnswers = [par('wk'), none()]
    await svc.send(c.id, '', [img])
    await idle(c.id)
    const items = await store.loadItems(c.id)
    expect(items[0]).toMatchObject({ type: 'user', text: '', attachments: [img] })
    expect(calls.map(agentOf)).toEqual(['wk'])
    expect(modInputs[0].messages[0]).toMatchObject({ from: null, text: '', attachments: [img] })
    expect((await store.get(c.id))?.title).toBe('pic.png')
  })

  it('keeps the id the client picked for its message, unless an item already has it', async () => {
    const c = await group()
    modAnswers = [none(), none()]
    await svc.send(c.id, 'one', [], undefined, 'm-1')
    await idle(c.id)
    await svc.send(c.id, 'two', [], undefined, 'm-1')
    await idle(c.id)
    const users = (await store.loadItems(c.id)).filter((i) => i.type === 'user')
    expect(users.map((u) => u.text)).toEqual(['one', 'two'])
    expect(users[0].id).toBe('m-1')
    expect(users[1].id).not.toBe('m-1')
  })

  it("a member's turn gets the note and image blocks and --add-dir", async () => {
    const c = await group()
    await write(c.id, [img])
    modAnswers = [par('ui'), none()]
    await svc.send(c.id, '@ui look', [img])
    await idle(c.id)
    const note = withNote(
      '@ui look',
      refsOf([img], (a) => files.pathOf(c.id, a))
    )
    expect(Array.isArray(calls[0].raw)).toBe(true)
    expect(calls[0].stdin).toContain(`<message from="user">${note}</message>`)
    expect(calls[0].stdin).toContain(`file ID: ${img.id}`)
    expect((calls[0].raw as unknown[])[1]).toEqual(imageBlock)
    expect(argAfter(calls[0].args, '--add-dir')).toBe(files.dirOf(c.id))
    expect(modInputs[0].messages[0].text).toBe('@ui look')
  })

  it('a member that already saw the message gets no image blocks next turn', async () => {
    const c = await group()
    await write(c.id, [img])
    modAnswers = [par('ui'), none(), par('ui'), none()]
    await svc.send(c.id, '@ui look', [img])
    await idle(c.id)
    await svc.send(c.id, '@ui and now?')
    await idle(c.id)
    expect(calls).toHaveLength(2)
    expect(typeof calls[1].raw).toBe('string')
    expect(calls[1].stdin).not.toContain('<attachments>')
    expect(calls[1].args).toContain('--add-dir')
  })

  it('send with no text and no attachments still rejects with Message is empty', async () => {
    const c = await group()
    await expect(svc.send(c.id, '   ', [])).rejects.toThrow('Message is empty')
    await expect(svc.send(c.id, '')).rejects.toThrow('Message is empty')
  })
})

describe('GroupService room loop', () => {
  it('routes a mentioned pair in moderator order', async () => {
    const c = await group()
    modAnswers = [seq('ui', 'wk'), none(), none()]
    await svc.send(c.id, '@wk @ui go')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'wk'])
    const items = await store.loadItems(c.id)
    expect(items[0]).toMatchObject({ type: 'user', text: '@wk @ui go' })
    expect(assistants(items).map((i) => i.agent)).toEqual(['ui', 'wk'])
    const meta = await metaOf(c.id)
    expect(meta.group.queue).toEqual([])
    expect(meta.group.active).toEqual([])
    expect(meta.inFlight).toBe(false)
    expect(meta.title).toBe('go')
    expect(modInputs[0]).toMatchObject({
      speaker: null,
      queue: [],
      mentioned: ['wk', 'ui'],
      messages: [{ from: null, text: '@wk @ui go' }]
    })
    expect(modInputs[0].members.map((m) => m.name)).toEqual(['ui', 'wk', 'ps'])
    expect(modInputs[0].members[0].description).toBe('ui role')
    expect(modInputs[1]).toMatchObject({ speaker: 'ui', queue: [expect.objectContaining({ agent: 'wk' })] })
    expect(chats.runningCount()).toBe(0)
  })

  it('a reply that mentions nobody is for the member it replies to, and quotes its message', async () => {
    const c = await group()
    modAnswers = [seq('wk'), none(), seq('wk'), none()]
    scripts.wk = [{ text: 'added the field' }, { text: 'because the form needs it' }]
    await svc.send(c.id, '@wk add it')
    await idle(c.id)
    const answer = assistants(await store.loadItems(c.id))[0]
    await svc.send(c.id, 'why?', [], answer.id)
    await idle(c.id)
    expect(modInputs[2].mentioned).toEqual(['wk'])
    expect(calls.map(agentOf)).toEqual(['wk', 'wk'])
    expect(calls[1].stdin).toContain('<message from="user"><reply_to from="wk">\nadded the field\n</reply_to>\n\nwhy?</message>')
    expect(calls[1].stdin.endsWith('The user mentioned you\nGive a real reply.')).toBe(true)
    const items = await store.loadItems(c.id)
    expect(items.find((i) => i.type === 'user' && i.text === 'why?')).toMatchObject({ replyTo: answer.id })
  })

  it('a reply that mentions a member goes to that member only', async () => {
    const c = await group()
    modAnswers = [seq('wk'), none(), seq('ps'), none()]
    await svc.send(c.id, '@wk add it')
    await idle(c.id)
    const answer = assistants(await store.loadItems(c.id))[0]
    await svc.send(c.id, '@ps check this', [], answer.id)
    await idle(c.id)
    expect(modInputs[2].mentioned).toEqual(['ps'])
    expect(calls.map(agentOf)).toEqual(['wk', 'ps'])
  })

  it('an agent mention hands off', async () => {
    const c = await group()
    modAnswers = [seq('ui'), none(), none()]
    scripts.ui = [{ text: '@wk please add it' }]
    await svc.send(c.id, '@ui start')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'wk'])
    expect(calls[0].stdin.endsWith('The user mentioned you\nGive a real reply.')).toBe(true)
    expect(calls[1].stdin).toContain('<message from="ui" name="Ui">@wk please add it</message>')
    expect(calls[1].stdin.endsWith('You were mentioned by @ui\nIf it asks nothing of you, reply with exactly [[PASS]].')).toBe(true)
  })

  it('a member another member only refers to may pass, and its pass leaves nothing behind', async () => {
    const c = await group()
    // The moderator missed the reference: wk still gets a turn, but may pass it.
    modAnswers = [seq('ui'), none(), none()]
    scripts.ui = [{ text: 'done, as @wk said' }]
    scripts.wk = [{ text: '[[PASS]]' }]
    await svc.send(c.id, '@ui start')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'wk'])
    const items = await store.loadItems(c.id)
    expect(assistants(items).map((i) => [i.agent, i.text])).toEqual([['ui', 'done, as @wk said']])
  })

  it('moderator adds a step-in', async () => {
    const c = await group()
    modAnswers = [seq('ui', 'ps')]
    await svc.send(c.id, '@ui check this')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'ps'])
    expect(calls[1].stdin).toContain('The moderator thinks you should weigh in')
  })

  it('a pass is hidden', async () => {
    const c = await group()
    modAnswers = [seq('ui', 'ps')]
    scripts.ps = [{ text: '[[PASS]]' }]
    await svc.send(c.id, '@ui check this')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'ps'])
    const items = await store.loadItems(c.id)
    expect(assistants(items).map((i) => i.agent)).toEqual(['ui'])
    const meta = await metaOf(c.id)
    expect(meta.group.seen.ps).toBe(assistants(items)[0].id)
    // ui's reply was routed; ps's pass was not
    expect(modInputs.map((i) => i.speaker)).toEqual([null, 'ui'])
  })

  describe('the room turn hook', () => {
    it('reports each member turn after its items are saved', async () => {
      const c = await group()
      modAnswers = [seq('ui', 'ps')]
      const saved: Record<string, (string | undefined)[]> = {}
      onRoomEnd = (e) => {
        roomEnds.push(e)
        // The hook fires after the save is awaited, so the stored thread already holds the turn's items.
        void store.loadItems(e.chatId).then((items) => {
          saved[e.agent] = assistants(items).map((i) => i.agent)
        })
      }
      await svc.send(c.id, '@ui check this')
      await idle(c.id)
      expect(roomEnds).toEqual([
        { chatId: c.id, agent: 'ui', outcome: 'ok', passed: false, reply: expect.any(String) },
        { chatId: c.id, agent: 'ps', outcome: 'ok', passed: false, reply: expect.any(String) }
      ])
      await until(() => saved.ui !== undefined, 'the saved items read')
      expect(saved.ui).toEqual(['ui'])
    })

    it('a pass is reported as passed', async () => {
      const c = await group()
      modAnswers = [seq('ui', 'ps')]
      scripts.ps = [{ text: PASS_MARKER }]
      await svc.send(c.id, '@ui check this')
      await idle(c.id)
      expect(roomEnds).toEqual([
        { chatId: c.id, agent: 'ui', outcome: 'ok', passed: false, reply: expect.any(String) },
        { chatId: c.id, agent: 'ps', outcome: 'ok', passed: true, reply: expect.any(String) }
      ])
    })

    it('a pass that kept its approval card is still passed', async () => {
      const c = await group()
      modAnswers = [seq('ui', 'ps')]
      scripts.ps = [
        passWith([
          { kind: 'toolUse', id: 't2', name: 'Bash', input: { command: 'ls' } },
          {
            kind: 'permissionRequest',
            requestId: 'r1',
            toolName: 'Bash',
            input: { command: 'ls' },
            description: null,
            reason: null,
            toolUseId: 't2'
          },
          { kind: 'toolResult', toolUseId: 't2', content: 'files', isError: false }
        ])
      ]
      await svc.send(c.id, '@ui check this')
      await idle(c.id)
      expect(by(await store.loadItems(c.id), 'ps').map((i) => i.type)).toEqual(['tool', 'approval'])
      expect(roomEnds.at(-1)).toEqual({ chatId: c.id, agent: 'ps', outcome: 'ok', passed: true, reply: expect.any(String) })
    })

    it("a member's turn end carries its reply text", async () => {
      const c = await group()
      modAnswers = [seq('ui'), none()]
      scripts.ui = [{ text: 'Done here' }]
      await svc.send(c.id, '@ui go')
      await idle(c.id)
      expect(roomEnds.map((e) => e.reply)).toEqual(['Done here'])
    })

    it('a failed member turn reports error', async () => {
      const c = await group()
      modAnswers = [seq('ui', 'wk')]
      scripts.ui = [{ events: [], outcome: { exitCode: 1, result: null } }]
      await svc.send(c.id, '@ui @wk go')
      await idle(c.id)
      expect(roomEnds).toEqual([{ chatId: c.id, agent: 'ui', outcome: 'error', passed: false, reply: expect.any(String) }])
    })

    it('a stopped member turn reports stopped', async () => {
      const c = await group()
      modAnswers = [seq('ui')]
      scripts.ui = [{ hang: true }]
      await svc.send(c.id, '@ui go')
      await until(() => live.length === 1, "ui's run to start")
      chats.stop(c.id)
      await idle(c.id)
      expect(roomEnds).toEqual([{ chatId: c.id, agent: 'ui', outcome: 'stopped', passed: false, reply: expect.any(String) }])
    })

    it('a throwing hook does not break the room', async () => {
      const c = await group()
      modAnswers = [seq('ui')]
      onRoomEnd = () => {
        throw new Error('boom')
      }
      await svc.send(c.id, '@ui check this')
      await idle(c.id)
      const items = await store.loadItems(c.id)
      expect(assistants(items).map((i) => i.agent)).toEqual(['ui'])
      expect(items.some((i) => i.type === 'error')).toBe(false)
    })
  })

  it('a pass counts toward the cap', async () => {
    const c = await group()
    fallback = (a) => (a === 'ps' ? { text: '[[PASS]]' } : { text: a === 'ui' ? '@wk next' : '@ui next' })
    // ps steps in beside every speaker, and always passes
    modFallback = (input) => (input.speaker === 'ps' ? none() : par(...input.mentioned, 'ps'))
    await svc.send(c.id, '@ui go')
    await idle(c.id)
    expect(calls).toHaveLength(15)
    expect(calls.filter((o) => agentOf(o) === 'ps')).toHaveLength(7)
    expect(assistants(await store.loadItems(c.id)).some((i) => i.agent === 'ps')).toBe(false)
    const items = await store.loadItems(c.id)
    expect(items[items.length - 1]).toMatchObject({ type: 'notice', kind: 'paused' })
  })

  it("a mentioned member's pass is shown", async () => {
    const c = await group()
    modAnswers = [seq('ui')]
    scripts.ui = [{ text: '[[PASS]]' }]
    await svc.send(c.id, '@ui check this')
    await idle(c.id)
    const items = await store.loadItems(c.id)
    expect(assistants(items)).toEqual([expect.objectContaining({ agent: 'ui', text: '[[PASS]]' })])
  })

  const passWith = (events: RunEvent[]): Script => ({
    events: [{ kind: 'init', sessionId: 's-pass' }, ...events, { kind: 'assistantText', text: '[[PASS]]' }, okResult]
  })
  const by = (items: ChatItem[], agent: string) => items.filter((i) => 'agent' in i && i.agent === agent)

  it("a step-in's pass drops its tool rows too", async () => {
    const c = await group()
    modAnswers = [seq('ui', 'ps')]
    scripts.ps = [
      passWith([
        { kind: 'thinking', text: 'Nothing here for me.' },
        { kind: 'toolUse', id: 't1', name: 'Read', input: { file_path: '/x' } },
        { kind: 'toolResult', toolUseId: 't1', content: 'ok', isError: false }
      ])
    ]
    await svc.send(c.id, '@ui check this')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'ps'])
    const items = await store.loadItems(c.id)
    // Its thinking goes with its tool rows.
    expect(by(items, 'ps')).toEqual([])
    expect(items.map((i) => i.type)).toEqual(['user', 'assistant'])
  })

  it("a step-in's pass keeps its tool rows when the turn asked for an approval", async () => {
    const c = await group()
    modAnswers = [seq('ui', 'ps', 'wk')]
    // ps: an approval card; wk: a tool the CLI blocked as needing approval
    scripts.ps = [
      passWith([
        { kind: 'toolUse', id: 't2', name: 'Bash', input: { command: 'ls' } },
        {
          kind: 'permissionRequest',
          requestId: 'r1',
          toolName: 'Bash',
          input: { command: 'ls' },
          description: null,
          reason: null,
          toolUseId: 't2'
        },
        { kind: 'toolResult', toolUseId: 't2', content: 'files', isError: false }
      ])
    ]
    scripts.wk = [
      passWith([
        { kind: 'toolUse', id: 't3', name: 'Read', input: { file_path: '/y' } },
        { kind: 'toolResult', toolUseId: 't3', content: 'ok', isError: false },
        { kind: 'toolUse', id: 't4', name: 'Bash', input: { command: 'rm x' } },
        { kind: 'toolResult', toolUseId: 't4', content: 'This command requires approval', isError: true }
      ])
    ]
    await svc.send(c.id, '@ui check this')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'ps', 'wk'])
    const items = await store.loadItems(c.id)
    expect(by(items, 'ps').map((i) => [i.type, i.id])).toEqual([
      ['tool', 't2'],
      ['approval', 'r1']
    ])
    expect(by(items, 'wk').map((i) => [i.type, i.id])).toEqual([
      ['tool', 't3'],
      ['tool', 't4']
    ])
    expect(by(items, 'wk')[1]).toMatchObject({ blocked: true })
    // the pass itself is never shown
    expect(assistants(items).map((i) => i.agent)).toEqual(['ui'])
  })

  it("matches a member's request against that member's own agent rules", async () => {
    const c = await group()
    modAnswers = [par('ui', 'wk')]
    const ask = (id: string): RunEvent[] => [
      { kind: 'toolUse', id: `t${id}`, name: 'Bash', input: { command: 'ls' } },
      {
        kind: 'permissionRequest',
        requestId: id,
        toolName: 'Bash',
        input: { command: 'ls' },
        description: null,
        reason: null,
        toolUseId: `t${id}`
      }
    ]
    scripts.ui = [{ events: [...ask('r1'), ...replyEvents('ui', 'ok').slice(1)] }]
    scripts.wk = [{ events: [...ask('r2'), ...replyEvents('wk', 'ok').slice(1)] }]
    await svc.send(c.id, '@ui @wk go')
    await idle(c.id)
    const cards = (await store.loadItems(c.id)).filter((i) => i.type === 'approval')
    expect(cards.map((i) => [(i as { agent?: string }).agent, (i as { status: string }).status]).sort()).toEqual([
      ['ui', 'auto-allowed-agent'],
      ['wk', 'unanswered']
    ])
  })

  it('"Allow always for this agent" saves the rule under the member that asked', async () => {
    const c = await group()
    modAnswers = [par('ui', 'wk')]
    scripts.ui = [{ hang: true }]
    scripts.wk = [{ hang: true }]
    await svc.send(c.id, '@ui @wk go')
    await until(() => calls.length === 2, 'both turns to start')
    // Both CLIs use request id r1: the answer must reach wk's card, and its rule must go to wk.
    const ask: RunEvent = {
      kind: 'permissionRequest',
      requestId: 'r1',
      toolName: 'Bash',
      input: { command: 'pwd' },
      description: null,
      reason: null,
      toolUseId: null
    }
    for (const l of live) l.emit(ask)
    await until(() => chats.pendingCount(c.id) === 2, 'both cards')
    chats.answer(c.id, 'r1', 'allow-agent', 'wk')
    expect(ruleAdds).toEqual([['wk', ruleOf('Bash', { command: 'pwd' })]])
    expect(chats.pendingCount(c.id)).toBe(1)
    for (const l of live) l.finish()
    await idle(c.id)
    const cards = (await store.loadItems(c.id)).filter((i) => i.type === 'approval')
    expect(cards.map((i) => [(i as { agent?: string }).agent, (i as { status: string }).status]).sort()).toEqual([
      ['ui', 'unanswered'],
      ['wk', 'allowed-agent']
    ])
  })

  it('answerQuestions reaches the asking member when request ids clash', async () => {
    const c = await group()
    modAnswers = [par('ui', 'wk')]
    scripts.ui = [{ hang: true }]
    scripts.wk = [{ hang: true }]
    await svc.send(c.id, '@ui @wk go')
    await until(() => calls.length === 2, 'both turns to start')
    // Both CLIs use request id r1: the answer must reach wk's card only.
    const ask: RunEvent = {
      kind: 'permissionRequest',
      requestId: 'r1',
      toolName: 'AskUserQuestion',
      input: q,
      description: null,
      reason: null,
      toolUseId: null
    }
    for (const l of live) l.emit(ask)
    await until(() => chats.pendingCount(c.id) === 2, 'both cards')
    chats.answerQuestions(c.id, 'r1', { 'Which?': 'Yes' }, 'wk')
    expect(chats.pendingCount(c.id)).toBe(1)
    for (const l of live) l.finish()
    await idle(c.id)
    const cards = (await store.loadItems(c.id)).filter((i) => i.type === 'approval')
    expect(cards.map((i) => [(i as { agent?: string }).agent, (i as { status: string }).status]).sort()).toEqual([
      ['ui', 'unanswered'],
      ['wk', 'answered']
    ])
  })

  it('pauses after 15 turns without the user', async () => {
    const c = await group()
    fallback = (a) => ({ text: a === 'ui' ? '@wk your turn' : '@ui your turn' })
    await svc.send(c.id, '@ui go')
    await idle(c.id)
    expect(calls).toHaveLength(15)
    const items = await store.loadItems(c.id)
    expect(items[items.length - 1]).toMatchObject({
      type: 'notice',
      kind: 'paused',
      text: 'Agents paused after 15 turns without you. Send a message to continue.'
    })
    const meta = await metaOf(c.id)
    expect(meta.group.queue).toEqual([])
    expect(meta.inFlight).toBe(false)
    // the next user message resets the count
    fallback = (a) => ({ text: `${a} done` })
    await svc.send(c.id, '@ui again')
    await idle(c.id)
    expect(calls).toHaveLength(16)
    expect(agentOf(calls[15])).toBe('ui')
  })

  it('answering a question restarts the turn count', async () => {
    const c = await group()
    fallback = (a) => ({ text: a === 'ui' ? '@wk your turn' : '@ui your turn' })
    scripts.ui = [{ hang: true, text: '@wk your turn' }]
    await svc.send(c.id, '@ui go')
    await until(() => calls.length === 1, 'the first turn to start')
    const ask: RunEvent = {
      kind: 'permissionRequest',
      requestId: 'r1',
      toolName: 'AskUserQuestion',
      input: q,
      description: null,
      reason: null,
      toolUseId: null
    }
    live[0].emit(ask)
    await until(() => chats.pendingCount(c.id) === 1, 'the question card')
    chats.answerQuestions(c.id, 'r1', { 'Which?': 'Yes' }, 'ui')
    live[0].finish()
    await idle(c.id)
    // turn 1, then 15 more after the reset
    expect(calls).toHaveLength(16)
    const items = await store.loadItems(c.id)
    expect(items[items.length - 1]).toMatchObject({
      type: 'notice',
      kind: 'paused',
      text: 'Agents paused after 15 turns without you. Send a message to continue.'
    })
  })

  it('a plan decision reaches the asking member and restarts the turn count', async () => {
    const c = await group()
    modAnswers = [par('ui', 'wk')]
    scripts.ui = [{ hang: true }]
    scripts.wk = [{ hang: true }]
    await svc.send(c.id, '@ui @wk go')
    await until(() => calls.length === 2, 'both turns to start')
    const ask: RunEvent = {
      kind: 'permissionRequest',
      requestId: 'r1',
      toolName: 'ExitPlanMode',
      input: { plan: '# P' },
      description: null,
      reason: null,
      toolUseId: null
    }
    for (const l of live) l.emit(ask)
    await until(() => chats.pendingCount(c.id) === 2, 'both plan cards')
    chats.answerPlan(c.id, 'r1', false, 'more detail', 'wk')
    expect(chats.pendingCount(c.id)).toBe(1)
    for (const l of live) l.finish()
    await idle(c.id)
    const cards = (await store.loadItems(c.id)).filter((i) => i.type === 'approval')
    expect(cards.map((i) => [(i as { agent?: string }).agent, (i as { status: string }).status]).sort()).toEqual([
      ['ui', 'unanswered'],
      ['wk', 'sent-back']
    ])
  })

  it('approving a plan restarts the turn count', async () => {
    const c = await group()
    fallback = (a) => ({ text: a === 'ui' ? '@wk your turn' : '@ui your turn' })
    scripts.ui = [{ hang: true, text: '@wk your turn' }]
    await svc.send(c.id, '@ui go')
    await until(() => calls.length === 1, 'the first turn to start')
    live[0].emit({
      kind: 'permissionRequest',
      requestId: 'r1',
      toolName: 'ExitPlanMode',
      input: { plan: '# P' },
      description: null,
      reason: null,
      toolUseId: null
    })
    await until(() => chats.pendingCount(c.id) === 1, 'the plan card')
    chats.answerPlan(c.id, 'r1', true, undefined, 'ui')
    live[0].finish()
    await idle(c.id)
    expect(calls).toHaveLength(16)
  })

  it('a failed turn halts the room', async () => {
    const c = await group()
    modAnswers = [seq('ui', 'wk')]
    scripts.ui = [{ events: [], outcome: { exitCode: 1, result: null } }]
    await svc.send(c.id, '@ui @wk go')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui'])
    expect(modInputs).toHaveLength(1)
    const items = await store.loadItems(c.id)
    expect(items).toContainEqual(expect.objectContaining({ type: 'error', text: 'Claude exited with code 1' }))
    const meta = await metaOf(c.id)
    expect(meta.group.queue).toEqual([])
    expect(meta.group.active).toEqual([])
    expect(meta.inFlight).toBe(false)
    // the next message starts the room again
    modAnswers = [seq('wk')]
    await svc.send(c.id, '@wk retry')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'wk'])
  })

  it('a failed turn leaves what the member has seen, so a retry still carries the request', async () => {
    const c = await group()
    modAnswers = [seq('ui'), seq('ui')]
    scripts.ui = [{ events: [], outcome: { spawnError: 'spawn claude ENOENT', result: null } }, { text: 'made it' }]
    await svc.send(c.id, '@ui make the card')
    await idle(c.id)
    expect(await store.loadItems(c.id)).toContainEqual(expect.objectContaining({ type: 'error', text: 'spawn claude ENOENT' }))
    expect((await metaOf(c.id)).group.seen).toEqual({})
    await svc.send(c.id, '@ui try again')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'ui'])
    expect(calls[1].stdin).toContain('<message from="user">@ui make the card</message>')
    expect(calls[1].stdin).toContain('<message from="user">@ui try again</message>')
  })

  it('a stopped turn still marks the messages seen', async () => {
    const c = await group()
    modAnswers = [seq('ui'), seq('ui')]
    scripts.ui = [{ hang: true }]
    await svc.send(c.id, '@ui go')
    await until(() => calls.length === 1, 'ui to start')
    chats.stop(c.id)
    await idle(c.id)
    const first = (await store.loadItems(c.id))[0]
    expect((await metaOf(c.id)).group.seen).toEqual({ ui: first.id })
    await svc.send(c.id, '@ui again')
    await idle(c.id)
    expect(calls[1].stdin).not.toContain('@ui go')
  })

  it('stop clears the queue and aborts the moderator', async () => {
    const c = await group()
    modAnswers = [seq('ui', 'wk'), 'hang']
    await svc.send(c.id, '@ui @wk go')
    await until(() => modInputs.length === 2, 'the second moderator call')
    expect((await metaOf(c.id)).group.queue.map((e) => e.agent)).toEqual(['wk'])
    chats.stop(c.id)
    await idle(c.id)
    expect(modSignals[1].aborted).toBe(true)
    expect(calls.map(agentOf)).toEqual(['ui'])
    const items = await store.loadItems(c.id)
    expect(items[items.length - 1]).toMatchObject({ type: 'notice', kind: 'stopped', text: 'Stopped.' })
    expect(items.filter((i) => i.type === 'notice')).toHaveLength(1)
    const meta = await metaOf(c.id)
    expect(meta.group.queue).toEqual([])
    expect(meta.group.active).toEqual([])
    expect(meta.inFlight).toBe(false)
    expect(chats.runningCount()).toBe(0)
  })

  it('stop during a turn clears the queue with one stopped notice', async () => {
    const c = await group()
    modAnswers = [seq('ui', 'wk')]
    scripts.ui = [{ hang: true }]
    await svc.send(c.id, '@ui @wk go')
    await until(() => calls.length === 1, 'ui to start')
    chats.stop(c.id)
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui'])
    expect(modInputs).toHaveLength(1)
    const items = await store.loadItems(c.id)
    expect(items.filter((i) => i.type === 'notice')).toEqual([expect.objectContaining({ kind: 'stopped' })])
    expect((await metaOf(c.id)).group.queue).toEqual([])
  })

  it('keeps a message sent mid-turn', async () => {
    const c = await group()
    modAnswers = [seq('ui')]
    scripts.ui = [{ hang: true }]
    await svc.send(c.id, '@ui go')
    await until(() => calls.length === 1, 'ui to start')
    await svc.send(c.id, '@wk also this')
    expect(chats.isRunning(c.id)).toBe(true)
    expect(calls).toHaveLength(1)
    expect((await store.loadItems(c.id)).map((i) => i.type === 'user' && i.text)).toContain('@wk also this')
    live[0].finish()
    await idle(c.id)
    const saved = await store.loadItems(c.id)
    expect(saved.filter((i) => i.type === 'user').map((i) => (i as { text: string }).text)).toEqual(['@ui go', '@wk also this'])
    expect(calls.map(agentOf)).toEqual(['ui', 'wk'])
    expect(calls[1].stdin).toContain('also this')
    expect(chats.runningCount()).toBe(0)
  })

  it('the running member sees a mid-turn message on its next turn', async () => {
    const c = await group()
    modAnswers = [seq('ui')]
    scripts.ui = [{ hang: true, events: replyEvents('ui', 'first') }, { text: 'second' }]
    await svc.send(c.id, '@ui go')
    await until(() => calls.length === 1, 'ui to start')
    await svc.send(c.id, '@ui and this')
    live[0].finish()
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'ui'])
    expect(calls[1].stdin).toContain('<message from="user">@ui and this</message>')
    expect(calls[1].stdin).not.toContain('@ui go')
    expect(calls[1].stdin.endsWith('The user mentioned you\nGive a real reply.')).toBe(true)
  })

  it('each member sees each message once', async () => {
    const c = await group(['ui', 'wk'])
    scripts.ui = [{ text: '@wk two' }, { text: 'four' }]
    scripts.wk = [{ text: '@ui three' }]
    await svc.send(c.id, '@ui one')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'wk', 'ui'])
    expect(calls[0].stdin).toContain('@ui one')
    expect(calls[1].stdin).toContain('@ui one')
    expect(calls[1].stdin).toContain('@wk two')
    expect(calls[2].stdin).toContain('@ui three')
    expect(calls[2].stdin).not.toContain('@ui one')
    expect(calls[2].stdin).not.toContain('@wk two')
  })

  it('briefing, snapshot and subagent block on group turns', async () => {
    const c = await group(['ui', 'wk'])
    deny = (a) => (a === 'ui' ? ['Edit(//x)'] : [])
    modAnswers = [seq('ui'), none(), seq('ui'), none()]
    await svc.send(c.id, '@ui one')
    await idle(c.id)
    await svc.send(c.id, '@ui two')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'ui'])
    const args = calls[0].args
    const briefing = argAfter(args, '--append-system-prompt')
    expect(briefing).toContain('You are @ui')
    expect(briefing).toContain('@wk (Wk): wk role')
    expect(briefing).toContain(dir)
    expect(briefing).not.toContain('[[PASS]]')
    expect(argAfter(args, '--system-prompt-snapshot')).toBe('off')
    expect(args.slice(args.indexOf('--disallowedTools') + 1)).toEqual(['Edit(//x)', 'Agent(wk)'])
    expect(args).not.toContain('--resume')
    expect(argAfter(calls[1].args, '--resume')).toBe('s-ui')
    expect(calls[1].args[calls[1].args.length - 1]).toBe('Agent(wk)')
    expect(args.join(' ')).not.toMatch(/dangerously|bypassPermissions/)
    expect((await metaOf(c.id)).group.sessions).toEqual({ ui: 's-ui' })
  })

  it("a workflow room's member turns get the workflow paragraph first and end as a workflow turn", async () => {
    const c = await group(['ui', 'wk'])
    await store.patchInPlace(c.id, () => ({ workflow: { workflowId: 'w1', runId: 'r1', stepId: 's1', name: 'WF' } }))
    const ends: { chatId: string; workflow?: true }[] = []
    chatDeps.onTurnEnd = (e) => {
      ends.push(e)
    }
    modAnswers = [seq('ui'), none()]
    await svc.send(c.id, '@ui one')
    await idle(c.id)
    const members = [
      { name: 'ui', description: 'ui role' },
      { name: 'wk', description: 'wk role' }
    ]
    // Joined as the side base joins it (app.ts), so a /btw side run shares the main turn's cache prefix.
    expect(argAfter(calls[0].args, '--append-system-prompt')).toBe(
      `${workflowSystem('WF')}\n\n${buildBriefing('ui', members, dir, '')}\n\n${RUN_SYSTEM}`
    )
    expect(ends.some((e) => e.chatId === c.id)).toBe(true)
    expect(ends.filter((e) => e.chatId === c.id).every((e) => e.workflow === true)).toBe(true)
  })

  it('a kept workflow room keeps the paragraph but its turn ends are not silent', async () => {
    const c = await group(['ui', 'wk'])
    await store.patchInPlace(c.id, () => ({ workflow: { workflowId: 'w1', runId: 'r1', stepId: 's1', name: 'WF', keep: true } }))
    const ends: { chatId: string; workflow?: true }[] = []
    chatDeps.onTurnEnd = (e) => {
      ends.push(e)
    }
    modAnswers = [seq('ui'), none()]
    await svc.send(c.id, '@ui one')
    await idle(c.id)
    const members = [
      { name: 'ui', description: 'ui role' },
      { name: 'wk', description: 'wk role' }
    ]
    expect(argAfter(calls[0].args, '--append-system-prompt')).toBe(
      `${workflowSystem('WF')}\n\n${buildBriefing('ui', members, dir, '')}\n\n${RUN_SYSTEM}`
    )
    const mine = ends.filter((e) => e.chatId === c.id)
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every((e) => e.workflow === undefined)).toBe(true)
  })

  it('a workflow room never routes on @mentions inside material, and tells the moderator it is material', async () => {
    const c = await group(['ui', 'wk'])
    await store.patchInPlace(c.id, () => ({ workflow: { workflowId: 'w', runId: 'r', stepId: 's', name: 'WF' } }))
    modAnswers = [none()]
    await svc.send(c.id, '@ui go\n\n<input from="trigger">\nping @wk @everyone\n</input>')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui'])
    expect(modInputs[0]).toMatchObject({ material: true, everyone: false, mentioned: ['ui'] })
  })

  it('the same text in a room without a workflow still routes the members it mentions', async () => {
    const c = await group(['ui', 'wk'])
    modAnswers = [none()]
    await svc.send(c.id, '@ui go\n\n<input from="trigger">\nping @wk\n</input>')
    await idle(c.id)
    expect(calls.map(agentOf).sort()).toEqual(['ui', 'wk'])
    expect(modInputs[0].material).toBeUndefined()
  })

  it('does not route an @mention inside an <input> block of a workflow-sent message, and tells the moderator it is material', async () => {
    const sent = { workflowId: 'w', runId: 'r', stepId: 's', name: 'WF', step: 'Chat' }
    const text = '@ui go\n\n<input from="trigger">\n@wk please @everyone\n</input>'
    const c = await group(['ui', 'wk'])
    modAnswers = [none()]
    await svc.send(c.id, text, [], undefined, undefined, undefined, undefined, sent)
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui'])
    expect(modInputs[0]).toMatchObject({ material: true, everyone: false, mentioned: ['ui'] })
    expect((await store.loadItems(c.id)).find((i) => i.type === 'user')).toMatchObject({ workflowSent: sent })
    // Without the marker the same text routes both, as before.
    const d = await group(['ui', 'wk'])
    calls.length = 0
    modAnswers = [none()]
    await svc.send(d.id, text)
    await idle(d.id)
    expect(calls.map(agentOf).sort()).toEqual(['ui', 'wk'])
  })

  it('a mention in a workflow-sent message block of a missing member leaves no notice', async () => {
    const c = await group(['ui', 'wk'])
    modAnswers = [none()]
    await svc.send(c.id, '@ui go\n\n<input from="trigger">\n@ghost\n</input>', [], undefined, undefined, undefined, undefined, {
      workflowId: 'w',
      runId: 'r',
      stepId: 's',
      name: 'WF',
      step: 'Chat'
    })
    await idle(c.id)
    expect((await store.loadItems(c.id)).some((i) => i.type === 'notice')).toBe(false)
  })

  it('a room without a workflow keeps the briefing alone and a plain turn end', async () => {
    const c = await group(['ui', 'wk'])
    const ends: { chatId: string; workflow?: true }[] = []
    chatDeps.onTurnEnd = (e) => {
      ends.push(e)
    }
    modAnswers = [seq('ui'), none()]
    await svc.send(c.id, '@ui one')
    await idle(c.id)
    const members = [
      { name: 'ui', description: 'ui role' },
      { name: 'wk', description: 'wk role' }
    ]
    expect(argAfter(calls[0].args, '--append-system-prompt')).toBe(`${buildBriefing('ui', members, dir, '')}\n\n${RUN_SYSTEM}`)
    expect(ends.some((e) => e.chatId === c.id)).toBe(true)
    expect(ends.every((e) => e.workflow === undefined)).toBe(true)
  })

  describe('workflow step rules', () => {
    const wf = { workflowId: 'w', runId: 'r', stepId: 's', name: 'WF' }
    const ask = (id: string, command = 'echo hi', extra: Record<string, unknown> = {}): RunEvent => ({
      kind: 'permissionRequest',
      requestId: id,
      toolName: 'Bash',
      input: { command, ...extra },
      description: null,
      reason: null,
      toolUseId: null
    })
    const cardsOf = async (id: string) =>
      (await store.loadItems(id)).filter((i) => i.type === 'approval') as unknown as {
        agent?: string
        status: string
        id: string
        toolName: string
      }[]
    const stepRules: ChatMeta['workflowRules'] = [{ tool: 'Bash', command: 'echo hi', agent: 'a' }]
    let stepAdds: [string, unknown][]
    beforeEach(() => {
      stepAdds = []
      chatDeps.onStepRule = (chatId, rule) => {
        stepAdds.push([chatId, rule])
      }
      agentList = ['a', 'b'].map((x) => agentSummary(x))
    })
    const room = async (withWorkflow = true) => {
      const c = await group(['a', 'b'])
      if (withWorkflow) await store.patchInPlace(c.id, () => ({ workflow: wf, workflowRules: stepRules }))
      return c
    }

    it("lets the rule's member through with no card, and asks for the other", async () => {
      const c = await room()
      modAnswers = [par('a', 'b')]
      scripts.a = [{ hang: true }]
      scripts.b = [{ hang: true }]
      await svc.send(c.id, '@a @b go')
      await until(() => calls.length === 2, 'both turns to start')
      for (const l of live) l.emit(ask('r1'))
      await until(() => chats.pendingCount(c.id) === 1, 'the card of b')
      const cards = await cardsOf(c.id)
      expect(cards.map((x) => [x.agent, x.status]).sort()).toEqual([
        ['a', 'auto-allowed-workflow'],
        ['b', 'pending']
      ])
      for (const l of live) l.finish()
      await idle(c.id)
    })

    it("'allow-step' stores the rule for the asking member, saves it once and allows its next identical call", async () => {
      const c = await room()
      modAnswers = [par('b')]
      scripts.b = [{ hang: true }]
      await svc.send(c.id, '@b go')
      await until(() => calls.length === 1, 'the turn to start')
      live[0].emit(ask('r1'))
      await until(() => chats.pendingCount(c.id) === 1, 'the card')
      chats.answer(c.id, 'r1', 'allow-step', 'b')
      expect(stepAdds).toEqual([[c.id, { tool: 'Bash', command: 'echo hi', agent: 'b' }]])
      live[0].emit(ask('r2'))
      await until(() => chats.pendingCount(c.id) === 0, 'no new card')
      live[0].finish()
      await idle(c.id)
      expect((await cardsOf(c.id)).map((x) => [x.id, x.status])).toEqual([
        ['r1', 'allowed-step'],
        ['r2', 'auto-allowed-workflow']
      ])
      expect(stepAdds).toHaveLength(1)
    })

    it('a rule just allowed survives a member turn that read the meta before it was saved', async () => {
      const c = await room()
      modAnswers = [par('b'), none()]
      scripts.b = [{ hang: true }]
      await svc.send(c.id, '@b go')
      await until(() => calls.length === 1, 'the turn to start')
      live[0].emit(ask('r1'))
      await until(() => chats.pendingCount(c.id) === 1, 'the card')
      chats.answer(c.id, 'r1', 'allow-step', 'b')
      live[0].finish()
      await idle(c.id)
      // The saver never wrote the meta (stepAdds only logs), so the next turn reads the old rules again.
      scripts.b = [{ hang: true }]
      modAnswers = [par('b'), none()]
      await svc.send(c.id, '@b again')
      await until(() => calls.length === 2, 'the second turn to start')
      live[1].emit(ask('r2'))
      await sleep(20)
      expect(chats.pendingCount(c.id)).toBe(0)
      live[1].finish()
      await idle(c.id)
      expect((await cardsOf(c.id)).map((x) => x.status)).toEqual(['allowed-step', 'auto-allowed-workflow'])
    })

    it("'allow-step' in a room without a workflow acts as allow-once and saves no rule", async () => {
      const c = await room(false)
      modAnswers = [par('b')]
      scripts.b = [{ hang: true }]
      await svc.send(c.id, '@b go')
      await until(() => calls.length === 1, 'the turn to start')
      live[0].emit(ask('r1'))
      await until(() => chats.pendingCount(c.id) === 1, 'the card')
      chats.answer(c.id, 'r1', 'allow-step', 'b')
      live[0].emit(ask('r2'))
      await until(() => chats.pendingCount(c.id) === 1, 'a card again')
      live[0].finish()
      await idle(c.id)
      expect(stepAdds).toEqual([])
      expect((await cardsOf(c.id)).map((x) => x.status)).toEqual(['allowed-once', 'unanswered'])
    })

    it("'allow-step' on an AskUserQuestion in a workflow room adds no rule, and the next identical question still asks", async () => {
      const c = await room()
      const askQ = (id: string): RunEvent => ({
        kind: 'permissionRequest',
        requestId: id,
        toolName: 'AskUserQuestion',
        input: q,
        description: null,
        reason: null,
        toolUseId: null
      })
      modAnswers = [par('b')]
      scripts.b = [{ hang: true }]
      await svc.send(c.id, '@b go')
      await until(() => calls.length === 1, 'the turn to start')
      live[0].emit(askQ('r1'))
      await until(() => chats.pendingCount(c.id) === 1, 'the question card')
      chats.answer(c.id, 'r1', 'allow-step', 'b')
      expect(stepAdds).toEqual([])
      live[0].emit(askQ('r2'))
      await until(() => chats.pendingCount(c.id) === 2, 'the second question to ask too')
      expect(stepAdds).toEqual([])
      live[0].finish()
      await idle(c.id)
      // Read after the turn ends: the cards are saved coalesced, so the store lags the live count.
      expect((await cardsOf(c.id)).map((x) => x.toolName)).toEqual(['AskUserQuestion', 'AskUserQuestion'])
      expect(stepAdds).toEqual([])
    })

    it("'allow-step' on a call whose rule could not be saved is allowed once, with no rule and no save", async () => {
      const c = await room()
      modAnswers = [par('b')]
      scripts.b = [{ hang: true }]
      await svc.send(c.id, '@b go')
      await until(() => calls.length === 1, 'the turn to start')
      live[0].emit(ask('r1', 'x'.repeat(5_000)))
      await until(() => chats.pendingCount(c.id) === 1, 'the card')
      chats.answer(c.id, 'r1', 'allow-step', 'b')
      expect(stepAdds).toEqual([])
      live[0].emit(ask('r2', 'x'.repeat(5_000)))
      await until(() => chats.pendingCount(c.id) === 1, 'the same call to ask again')
      expect((await store.get(c.id))!.workflowRules).toEqual(stepRules)
      live[0].finish()
      await idle(c.id)
    })

    it("'allow-step' on a delete adds no rule, and a stored rule never allows it", async () => {
      const c = await room()
      const del = 'mcp__zumibot_automations__routine_delete'
      await store.patchInPlace(c.id, () => ({ workflowRules: [{ tool: del }] }))
      modAnswers = [par('b')]
      scripts.b = [{ hang: true }]
      await svc.send(c.id, '@b go')
      await until(() => calls.length === 1, 'the turn to start')
      live[0].emit({
        kind: 'permissionRequest',
        requestId: 'r1',
        toolName: del,
        input: { id: 'x', name: 'y' },
        description: null,
        reason: null,
        toolUseId: null
      })
      await until(() => chats.pendingCount(c.id) === 1, 'the card')
      chats.answer(c.id, 'r1', 'allow-step', 'b')
      expect(stepAdds).toEqual([])
      live[0].finish()
      await idle(c.id)
    })

    it('a fresh ChatService on the same store reads the rules at the next member turn', async () => {
      const c = await room()
      chats = new ChatService({ ...chatDeps })
      svc = new GroupService({
        store,
        chats,
        files,
        agents: async () => agentList,
        moderate: async () => par('a'),
        push: (p) => pushes.push(p),
        now: () => 1000 + n,
        newId: () => `x${++n}`,
        disallowedToolsFor: () => []
      })
      scripts.a = [{ hang: true }]
      await svc.send(c.id, '@a go')
      await until(() => calls.length === 1, 'the turn to start')
      live[0].emit(ask('r1'))
      await sleep(20)
      expect((await cardsOf(c.id)).map((x) => x.status)).toEqual(['auto-allowed-workflow'])
      live[0].finish()
      await idle(c.id)
    })
  })

  it('house style follows the briefing in one system prompt', async () => {
    const c = await group(['ui', 'wk'])
    style = true
    modAnswers = [seq('ui'), none()]
    await svc.send(c.id, '@ui one')
    await idle(c.id)
    const args = calls[0].args
    expect(args.filter((a) => a === '--append-system-prompt')).toHaveLength(1)
    const system = argAfter(args, '--append-system-prompt')
    expect(system.endsWith(RUN_SYSTEM)).toBe(true)
    expect(system.indexOf('You are @ui')).toBeLessThan(system.indexOf(HOUSE_STYLE))
    expect(system.indexOf(HOUSE_STYLE)).toBeLessThan(system.indexOf(RUN_SYSTEM))
    expect(args.filter((a) => a === '--system-prompt-snapshot')).toHaveLength(1)
  })

  it('expired session reseeds with labeled history', async () => {
    const c = await group(['ui', 'wk'])
    const prior: ChatItem[] = [
      { type: 'user', id: 'u0', text: 'start', ts: 1 },
      { type: 'assistant', id: 'b0', text: 'wk first', ts: 2, agent: 'wk' },
      { type: 'assistant', id: 'a0', text: 'ui earlier', ts: 3, agent: 'ui' },
      { type: 'assistant', id: 'b1', text: 'wk later', ts: 4, agent: 'wk' }
    ]
    await store.saveItems(c.id, prior)
    await store.updateGroup(c.id, (g) => ({ ...g, sessions: { ui: 'old', wk: 'w1' }, seen: { ui: 'b0', wk: 'a0' } }))
    modAnswers = [seq('ui')]
    scripts.ui = [
      { events: [], outcome: { exitCode: 1, stderr: 'No conversation found with session ID: old', result: null } },
      { text: 'back' }
    ]
    await svc.send(c.id, '@ui more')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'ui'])
    expect(argAfter(calls[0].args, '--resume')).toBe('old')
    expect(calls[1].args).not.toContain('--resume')
    const seed = calls[1].stdin
    expect(seed.startsWith("[ZumiBot] This chat's earlier session expired")).toBe(true)
    expect(seed).toContain('User: start')
    expect(seed).toContain('Wk: wk first')
    expect(seed).toContain('Ui: ui earlier')
    // messages already in the turn prompt are not repeated in the restored history
    expect(seed.split('wk later')).toHaveLength(2)
    expect(seed.split('@ui more')).toHaveLength(2)
    expect(seed).toBe(buildSeedPrompt(prior.slice(0, 3), calls[0].stdin))
    const items = await store.loadItems(c.id)
    expect(items.some((i) => i.type === 'notice' && i.kind === 'expired')).toBe(true)
    expect((await metaOf(c.id)).group.sessions.ui).toBe('s-ui')
  })

  it('a fresh start (a routine set to start fresh) reseeds the member and says so, not that it expired', async () => {
    const c = await group(['ui', 'wk'])
    await store.saveItems(c.id, [
      { type: 'user', id: 'u0', text: 'start', ts: 1 },
      { type: 'assistant', id: 'a0', text: 'ui earlier', ts: 2, agent: 'ui' }
    ])
    await store.updateGroup(c.id, (g) => ({
      ...g,
      sessions: { ui: 'old', wk: null },
      seen: { ui: 'a0' },
      next: { ui: { seed: true, fresh: true } }
    }))
    modAnswers = [seq('ui')]
    scripts.ui = [{ text: 'checked' }]
    await svc.send(c.id, '@ui daily check')
    await idle(c.id)
    expect(calls[0].args).not.toContain('--resume')
    const kinds = (await store.loadItems(c.id)).flatMap((i) => (i.type === 'notice' ? [i.kind] : []))
    expect(kinds).toEqual(['fresh'])
    expect((await metaOf(c.id)).group.next?.ui).toBeUndefined()
  })

  it("a reseed leaves out other members' tool rows and keeps its own", async () => {
    const c = await group(['ui', 'wk'])
    const tool = (id: string, path: string, agent: string): ChatItem => ({
      type: 'tool',
      id,
      name: 'Edit',
      input: { file_path: path },
      result: 'ok',
      isError: false,
      blocked: false,
      ts: 1,
      agent
    })
    const prior: ChatItem[] = [
      { type: 'user', id: 'u0', text: 'start', ts: 1 },
      tool('t0', '/theirs.md', 'wk'),
      { type: 'assistant', id: 'b0', text: 'wk first', ts: 2, agent: 'wk' },
      tool('t1', '/mine.md', 'ui'),
      { type: 'assistant', id: 'a0', text: 'ui earlier', ts: 3, agent: 'ui' }
    ]
    await store.saveItems(c.id, prior)
    await store.updateGroup(c.id, (g) => ({ ...g, sessions: { ui: 'old' }, seen: { ui: 'a0' } }))
    modAnswers = [seq('ui')]
    scripts.ui = [
      { events: [], outcome: { exitCode: 1, stderr: 'No conversation found with session ID: old', result: null } },
      { text: 'back' }
    ]
    await svc.send(c.id, '@ui more')
    await idle(c.id)
    const seed = calls[1].stdin
    expect(seed).toContain('[Tool] Edit /mine.md')
    expect(seed).not.toContain('/theirs.md')
    expect(seed).toContain('Wk: wk first')
    expect(seed).toBe(buildSeedPrompt([prior[0], prior[2], prior[3], prior[4]], calls[0].stdin))
  })

  it('caps the turn message of a member whose seen item is gone, keeping the newest messages and the reason', async () => {
    const c = await group(['ui', 'wk'])
    const prior: ChatItem[] = Array.from({ length: 30 }, (_, k) => ({
      type: 'user',
      id: `u${k}`,
      text: `p${k} ${'z'.repeat(5000)}`,
      ts: k
    }))
    await store.saveItems(c.id, prior)
    await store.updateGroup(c.id, (g) => ({ ...g, seen: { ui: 'deleted-item' } }))
    modAnswers = [seq('ui')]
    await svc.send(c.id, '@ui go')
    await idle(c.id)
    const stdin = calls[0].stdin
    expect(stdin.length).toBeLessThanOrEqual(SEED_MAX_CHARS)
    expect(stdin.startsWith('[Earlier messages omitted]\n')).toBe(true)
    expect(stdin).not.toContain('p0 ')
    expect(stdin).toContain('p29 ')
    expect(stdin.endsWith('<message from="user">@ui go</message>\nThe user mentioned you\nGive a real reply.')).toBe(true)
  })

  it('counts a running room', async () => {
    const c = await group()
    modAnswers = [seq('ui')]
    scripts.ui = [{ hang: true }]
    expect(chats.runningCount()).toBe(0)
    await svc.send(c.id, '@ui go')
    await until(() => calls.length === 1, 'ui to start')
    expect(chats.runningCount()).toBe(1)
    const running = await metaOf(c.id)
    expect(running.inFlight).toBe(true)
    expect(running.group.active.map((t) => t.agent)).toEqual(['ui'])
    live[0].finish()
    await idle(c.id)
    expect(chats.runningCount()).toBe(0)
  })

  it('a mention of a missing member adds a notice instead of a turn', async () => {
    const c = await group(['ui', 'wk', 'gone'])
    modAnswers = [seq('ui')]
    await svc.send(c.id, '@gone @ui hi')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui'])
    const items = await store.loadItems(c.id)
    expect(items[1]).toMatchObject({ type: 'notice', kind: 'unavailable', text: 'Gone is no longer available.' })
    expect(modInputs[0].mentioned).toEqual(['ui'])
    expect(modInputs[0].members.map((m) => m.name)).toEqual(['ui', 'wk'])
  })

  it('a member whose agent file fails to load is unavailable', async () => {
    const c = await group()
    agentList = agentList.map((a) => (a.name === 'wk' ? { ...a, error: 'bad yaml' } : a))
    modAnswers = [seq('ui'), seq('wk')]
    scripts.ui = [{ text: '@wk your turn' }]
    await svc.send(c.id, '@wk @ui hi')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui'])
    const items = await store.loadItems(c.id)
    const notices = items.filter((i) => i.type === 'notice')
    expect(notices).toEqual([
      expect.objectContaining({ kind: 'unavailable', text: 'Wk is no longer available.' }),
      expect.objectContaining({ kind: 'unavailable', text: 'Wk is no longer available.' })
    ])
    expect(items[1]).toMatchObject({ type: 'notice', kind: 'unavailable' })
    expect(modInputs[0].mentioned).toEqual(['ui'])
    expect(modInputs[0].members.map((m) => m.name)).toEqual(['ui', 'ps'])
    expect(items.some((i) => i.type === 'error')).toBe(false)
  })

  it('a valid agent is available even when a broken duplicate shares its name', async () => {
    const c = await group()
    agentList = [{ ...agentSummary('wk'), filePath: '/agents/copy.md', description: 'a copy', error: 'Duplicate name' }, ...agentList]
    modAnswers = [seq('wk')]
    await svc.send(c.id, '@wk hi')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['wk'])
    expect(modInputs[0].members.find((m) => m.name === 'wk')?.description).toBe('wk role')
  })

  it('with Codex rooms off, a member whose agent moved to Codex after it joined is refused with the fixed sentence and never runs on Claude', async () => {
    const asked: string[] = []
    const make = (engineOf?: (agent: string) => Promise<'claude' | 'codex'>) =>
      new GroupService({
        store,
        chats,
        files,
        agents: async () => agentList,
        moderate: async () => (modAnswers.length > 0 ? (modAnswers.shift() as ModeratorAnswer) : none()),
        push: (p) => pushes.push(p),
        now: () => 1000 + n,
        newId: () => `x${++n}`,
        disallowedToolsFor: () => [],
        caps: noCodexRooms,
        ...(engineOf ? { engineOf } : {})
      })
    svc = make(async (agent) => {
      asked.push(agent)
      return agent === 'wk' ? 'codex' : 'claude'
    })
    const c = await group()
    modAnswers = [par('ui', 'wk')]
    await svc.send(c.id, '@ui @wk go')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui'])
    expect(asked.sort()).toEqual(['ui', 'wk'])
    const items = await store.loadItems(c.id)
    expect(items).toContainEqual(expect.objectContaining({ type: 'error', text: CODEX_REFUSALS.room('wk') }))
    expect(assistants(items).map((i) => i.agent)).toEqual(['ui'])

    // Without the dep a room runs as it always did.
    svc = make()
    const d = await group()
    modAnswers = [par('ui', 'wk')]
    await svc.send(d.id, '@ui @wk go')
    await idle(d.id)
    expect(calls.map(agentOf).slice(1).sort()).toEqual(['ui', 'wk'])
  })

  it('a failed moderator falls back with a quiet notice', async () => {
    const c = await group()
    modAnswers = [null]
    await svc.send(c.id, '@wk @ui go')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['wk', 'ui'])
    let items = await store.loadItems(c.id)
    expect(items[1]).toMatchObject({ type: 'notice', kind: 'moderator', text: "Couldn't check who else should reply." })

    const d = await group()
    modAnswers = [null]
    await svc.send(d.id, 'hello')
    await idle(d.id)
    expect(agentOf(calls[2])).toBe('ui')
    expect(calls[2].stdin.endsWith("The user's message is for the group; please answer it.\nGive a real reply.")).toBe(true)
    items = await store.loadItems(d.id)
    expect(items[1]).toMatchObject({ type: 'notice', kind: 'moderator', text: "Couldn't check who else should reply, so Ui answers." })
  })

  it('a queued step-in that another member mentions is told it may pass', async () => {
    const c = await group()
    modAnswers = [seq('ui', 'ps')]
    scripts.ui = [{ text: '@ps please check' }]
    scripts.ps = [{ text: '[[PASS]]' }]
    await svc.send(c.id, '@ui go')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'ps'])
    expect(calls[1].stdin.endsWith('You were mentioned by @ui\nIf it asks nothing of you, reply with exactly [[PASS]].')).toBe(true)
    // Mentioned by a member, not the user: its pass is dropped like a step-in's.
    const items = await store.loadItems(c.id)
    expect(assistants(items).map((i) => i.agent)).toEqual(['ui'])
  })

  it('a member the user mentioned keeps its reason when a later message picks it again', async () => {
    const c = await group()
    modAnswers = [{ next: [pick('ps'), pick('ui', ['ps'])], drop: [], skip: [], askUser: false }, seq('ui')]
    scripts.ps = [{ hang: true }]
    scripts.ui = [{ text: '[[PASS]]' }]
    await svc.send(c.id, '@ps @ui hi')
    await until(() => calls.length === 1, 'ps to start')
    await svc.send(c.id, 'hello') // ui is still queued, waiting for ps
    await until(() => modInputs.length === 2, 'the moderator call for the second message')
    live[0].finish()
    await idle(c.id)
    expect(modInputs[1]).toMatchObject({ speaker: null, queue: [expect.objectContaining({ agent: 'ui' })], mentioned: [] })
    expect(calls.map(agentOf)).toEqual(['ps', 'ui', 'wk'])
    expect(calls[1].stdin.endsWith('The user mentioned you\nGive a real reply.')).toBe(true)
    expect(calls[2].stdin.endsWith("The user's message is for the group; please answer it.\nGive a real reply.")).toBe(true)
    const items = await store.loadItems(c.id)
    expect(assistants(items).map((i) => [i.agent, i.text])).toEqual([
      ['ps', 'ps done'],
      ['ui', '[[PASS]]'],
      ['wk', 'wk done']
    ])
  })

  it('a member picked to answer an unmentioned message cannot pass', async () => {
    const c = await group()
    modAnswers = [seq('wk')]
    scripts.wk = [{ text: '[[PASS]]' }]
    await svc.send(c.id, 'anyone there?')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['wk'])
    expect(calls[0].stdin.endsWith("The user's message is for the group; please answer it.\nGive a real reply.")).toBe(true)
    expect(calls[0].stdin).not.toContain('[[PASS]]')
    const items = await store.loadItems(c.id)
    expect(assistants(items)).toEqual([expect.objectContaining({ agent: 'wk', text: '[[PASS]]' })])
  })

  it('only the first member picked for an unmentioned message must answer; the rest may pass', async () => {
    const c = await group()
    modAnswers = [seq('wk', 'ps')]
    scripts.wk = [{ text: 'here' }]
    scripts.ps = [{ text: '[[PASS]]' }]
    await svc.send(c.id, 'anyone there?')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['wk', 'ps'])
    expect(calls[0].stdin.endsWith("The user's message is for the group; please answer it.\nGive a real reply.")).toBe(true)
    expect(calls[1].stdin).toContain('The moderator thinks you should weigh in')
    expect(calls[1].stdin).toContain('[[PASS]]')
    const items = await store.loadItems(c.id)
    expect(assistants(items).map((i) => [i.agent, i.text])).toEqual([['wk', 'here']])
  })

  it('the fallback answerer is the last speaker still available', async () => {
    const c = await group(['ui', 'wk', 'gone'])
    await store.saveItems(c.id, [
      { type: 'user', id: 'u0', text: 'hi', ts: 1 },
      { type: 'assistant', id: 'a0', text: 'from wk', ts: 2, agent: 'wk' }
    ])
    modAnswers = [null]
    await svc.send(c.id, 'hello')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['wk'])

    const d = await group(['ui', 'wk', 'gone'])
    await store.saveItems(d.id, [
      { type: 'user', id: 'u0', text: 'hi', ts: 1 },
      { type: 'assistant', id: 'a0', text: 'from gone', ts: 2, agent: 'gone' }
    ])
    modAnswers = [null]
    await svc.send(d.id, 'hello')
    await idle(d.id)
    expect(calls.map(agentOf)).toEqual(['wk', 'ui'])
    const items = await store.loadItems(d.id)
    expect(items).toContainEqual(
      expect.objectContaining({ kind: 'moderator', text: "Couldn't check who else should reply, so Ui answers." })
    )
  })

  it('a message posted while the moderator runs is still routed', async () => {
    const c = await group()
    let late: Promise<void> | null = null
    modAnswers = [seq('ui')]
    modFallback = (input) => {
      if (input.speaker === 'ui' && late === null) late = svc.send(c.id, '@wk late')
      return none()
    }
    await svc.send(c.id, '@ui go')
    await until(() => late !== null, 'the late send')
    await late
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'wk'])
    expect(calls[1].stdin).toContain('@wk late')
  })

  it('a message posted while the room winds down starts a new room', async () => {
    const c = await group()
    let late: Promise<void> | null = null
    const update = store.update.bind(store)
    store.update = async (id, patch) => {
      if (patch.inFlight === false && late === null) {
        late = svc.send(id, '@wk late')
        await sleep(20)
      }
      return update(id, patch)
    }
    modAnswers = [seq('ui')]
    await svc.send(c.id, '@ui go')
    await until(() => late !== null, 'the late send')
    await late
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'wk'])
    const items = await store.loadItems(c.id)
    expect(items.filter((i) => i.type === 'user').map((i) => (i as { text: string }).text)).toEqual(['@ui go', '@wk late'])
    expect((await metaOf(c.id)).inFlight).toBe(false)
  })

  it('send validates', async () => {
    const c = await group()
    await expect(svc.send(c.id, '   ')).rejects.toThrow()
    const single = await store.create('ui', dir)
    await expect(svc.send(single.id, 'hi')).rejects.toThrow()
    await expect(svc.send('nope', 'hi')).rejects.toThrow()
    expect(chats.runningCount()).toBe(0)
    expect(calls).toHaveLength(0)
    expect(await store.loadItems(c.id)).toEqual([])
  })

  it('setMembers validates', async () => {
    const c = await group()
    await store.updateGroup(c.id, (g) => ({ ...g, sessions: { ui: 's1', wk: 's2' }, seen: { ui: 'i1', wk: 'i2' } }))
    await expect(svc.setMembers(c.id, ['ui'])).rejects.toThrow()
    await expect(svc.setMembers(c.id, ['ui', 'ui'])).rejects.toThrow()
    await expect(svc.setMembers(c.id, ['ui', ZUMI_BOT_NAME])).rejects.toThrow()
    await expect(svc.setMembers(c.id, ['ui', 'ghost'])).rejects.toThrow()

    modAnswers = [seq('ui')]
    scripts.ui = [{ hang: true }]
    await svc.send(c.id, '@ui go')
    await until(() => calls.length === 1, 'ui to start')
    await expect(svc.setMembers(c.id, ['ui', 'ps'])).rejects.toThrow()
    chats.stop(c.id)
    await idle(c.id)

    const prev = (await metaOf(c.id)).group
    expect(prev.seen.wk).toBe('i2')
    const meta = await svc.setMembers(c.id, ['ui', 'ps'])
    expect(meta.group).toMatchObject({ members: ['ui', 'ps'], sessions: { ui: prev.sessions.ui }, seen: { ui: prev.seen.ui } })
    expect(meta.group?.sessions).not.toHaveProperty('wk')
    expect(meta.group?.seen).not.toHaveProperty('wk')
    expect((await metaOf(c.id)).group.members).toEqual(['ui', 'ps'])
    expect(pushes).toContainEqual({ chatId: c.id, kind: 'meta', meta })

    // a member whose agent file is gone may stay until removed
    const d = await group(['ui', 'gone'])
    expect((await svc.setMembers(d.id, ['ui', 'gone', 'wk'])).group?.members).toEqual(['ui', 'gone', 'wk'])

    const single = await store.create('ui', dir)
    await expect(svc.setMembers(single.id, ['ui', 'wk'])).rejects.toThrow()
  })
})

describe('GroupService members working side by side', () => {
  const groupsPushed = (id: string) => pushes.flatMap((p) => (p.kind === 'meta' && p.chatId === id && p.meta.group ? [p.meta.group] : []))
  const lastGroup = (id: string) => groupsPushed(id).pop()
  const notices = (items: ChatItem[]) => items.filter((i): i is Extract<ChatItem, { type: 'notice' }> => i.type === 'notice')
  const failing: Script = { hang: true, events: [], outcome: { exitCode: 1, result: null } }
  const isLive = (i: ChatItem) => 'turn' in i && i.turn !== undefined
  // A turn's items reached the thread: the pushed list holds one of them without a turn stamp.
  const posted = (id: string, match: (i: ChatItem) => boolean) =>
    pushes.some((p) => p.kind === 'items' && p.chatId === id && p.items.some((i) => match(i) && !isLive(i)))

  // Holds the room's second group write from now on (its save after starting turns) until `release` holds, so a turn
  // can end while the room is busy saving. Returns whether the hold happened.
  const holdSecondWrite = (release: () => boolean) => {
    let count = 0
    let held = false
    const updateGroup = store.updateGroup.bind(store)
    store.updateGroup = async (id, fn) => {
      if (++count === 2) {
        held = true
        await until(release, 'the held write to be released')
      }
      return updateGroup(id, fn)
    }
    return () => held
  }
  const queueIs = (g: GroupInfo, names: string) => g.queue.map((e) => e.agent).join() === names

  it('a member whose wait clears while the room saves never starts ahead of what it waits for', async () => {
    agentList = ['ui', 'wk', 'ps', 'gg'].map((a) => agentSummary(a))
    const c = await store.createGroup(['ui', 'wk', 'ps', 'gg'], dir)
    scripts.ps = [{ text: '[[PASS]]' }]
    scripts.ui = [{ hang: true }]
    scripts.wk = [{ hang: true }]
    let held = () => false
    modFallback = (input) => {
      if (input.speaker !== null) return none()
      // gg's agent goes away, so the room saves twice while ps runs; ps passes and ends meanwhile
      agentList = agentList.filter((a) => a.name !== 'gg')
      held = holdSecondWrite(() => groupsPushed(c.id).some((g) => queueIs(g, 'wk,ui') && g.active.length === 0))
      return { next: [pick('ps'), pick('wk', ['ui']), pick('ui', ['ps']), pick('gg')], drop: [], skip: [], askUser: false }
    }
    await svc.send(c.id, '@wk @ui go')
    await until(() => calls.length >= 2, 'the member after ps to start')
    expect(held()).toBe(true)
    expect(calls.map(agentOf)).toEqual(['ps', 'ui'])
    expect((await metaOf(c.id)).group.queue).toEqual([{ agent: 'wk', after: ['ui'] }])
    live[1].finish()
    await until(() => calls.length === 3, 'wk to start after ui')
    live[2].finish()
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ps', 'ui', 'wk'])
    expect(await store.loadItems(c.id)).toContainEqual(expect.objectContaining({ kind: 'unavailable', text: 'Gg is no longer available.' }))
  })

  it('a member whose wait clears while the room saves starts without waiting for the others', async () => {
    const c = await group()
    scripts.ps = [{ text: '[[PASS]]' }]
    scripts.ui = [{ hang: true }]
    scripts.wk = [{ hang: true }]
    let held = () => false
    modFallback = (input) => {
      if (input.speaker !== null) return none()
      // ps passes and ends while the room saves the turns it started; ui keeps working
      held = holdSecondWrite(() => groupsPushed(c.id).some((g) => queueIs(g, 'wk') && g.active.map((t) => t.agent).join() === 'ui'))
      return { next: [pick('ps'), pick('ui'), pick('wk', ['ps'])], drop: [], skip: [], askUser: false }
    }
    await svc.send(c.id, '@ui @wk go')
    await until(() => calls.length === 3, 'wk to start while ui still works')
    expect(held()).toBe(true)
    expect(calls.map(agentOf)).toEqual(['ps', 'ui', 'wk'])
    live[1].finish()
    live[2].finish()
    await idle(c.id)
  })

  it('setRole refuses a role over the limit', async () => {
    const c = await group()
    await expect(svc.setRole(c.id, 'x'.repeat(ROLE_MAX_CHARS + 1))).rejects.toThrow(`${ROLE_MAX_CHARS} characters`)
    expect((await metaOf(c.id)).group.role).toBe('')
    expect((await svc.setRole(c.id, 'x'.repeat(ROLE_MAX_CHARS))).group?.role).toHaveLength(ROLE_MAX_CHARS)
  })

  it('starts mentioned members side by side', async () => {
    const c = await group()
    modAnswers = [par('ui', 'wk')]
    scripts.ui = [{ hang: true }]
    scripts.wk = [{ hang: true }]
    await svc.send(c.id, '@ui @wk go')
    await until(() => calls.length === 2, 'both to start')
    expect(calls.map(agentOf)).toEqual(['ui', 'wk'])
    const { active, queue } = (await metaOf(c.id)).group
    expect(active.map((t) => t.agent)).toEqual(['ui', 'wk'])
    expect(active[0].turn).not.toBe(active[1].turn)
    expect(queue).toEqual([])
    live[0].finish()
    live[1].finish()
    await idle(c.id)
    expect((await metaOf(c.id)).group.active).toEqual([])
  })

  it('posts each finished turn in one piece, in finish order', async () => {
    const c = await group()
    modAnswers = [par('ui', 'wk')]
    scripts.ui = [{ hang: true, events: [{ kind: 'assistantText', text: 'ui says' }, okResult] }]
    scripts.wk = [{ hang: true, events: [{ kind: 'assistantText', text: 'wk says' }, okResult] }]
    await svc.send(c.id, '@ui @wk go')
    await until(() => calls.length === 2, 'both to start')
    live[0].emit({ kind: 'toolUse', id: 'tu1', name: 'Read', input: { file_path: '/a' } })
    live[1].emit({ kind: 'toolUse', id: 'tw1', name: 'Read', input: { file_path: '/b' } })
    live[0].emit({ kind: 'toolResult', toolUseId: 'tu1', content: 'ok', isError: false })
    live[1].emit({ kind: 'assistantText', text: 'wk thinking' })
    live[0].emit({ kind: 'assistantText', text: 'ui thinking' })
    live[1].finish()
    await until(() => modInputs.length === 2, "wk's reply to be routed")
    // wk's turn is in the thread; ui's is still live, stamped with its turn
    const mid = await store.loadItems(c.id)
    expect(mid.filter((i) => !isLive(i)).map((i) => i.id)).toEqual([mid[0].id, 'tw1', expect.any(String), expect.any(String)])
    expect(mid.filter(isLive).every((i) => 'agent' in i && i.agent === 'ui')).toBe(true)
    live[0].finish()
    await idle(c.id)
    const items = await store.loadItems(c.id)
    const row = (i: ChatItem) => [i.type, 'agent' in i ? i.agent : null, i.type === 'tool' ? i.id : 'text' in i ? i.text : null]
    expect(items.map(row)).toEqual([
      ['user', null, '@ui @wk go'],
      ['tool', 'wk', 'tw1'],
      ['assistant', 'wk', 'wk thinking'],
      ['assistant', 'wk', 'wk says'],
      ['tool', 'ui', 'tu1'],
      ['assistant', 'ui', 'ui thinking'],
      ['assistant', 'ui', 'ui says']
    ])
    expect(items.some((i) => 'turn' in i)).toBe(false)
  })

  it('a waiting member starts only after the moderator routed every reply it waits for', async () => {
    const c = await group()
    let routePs: (a: ModeratorAnswer) => void = () => {}
    modAnswers = [{ next: [pick('ui'), pick('ps'), pick('wk', ['ui', 'ps'])], drop: [], skip: [], askUser: false }]
    modFallback = (input) =>
      input.speaker === 'ps'
        ? new Promise<ModeratorAnswer>((resolve) => {
            routePs = resolve
          })
        : none()
    scripts.ui = [{ hang: true }]
    scripts.ps = [{ hang: true }]
    await svc.send(c.id, '@ui @ps check it, then @wk merges')
    await until(() => calls.length === 2, 'ui and ps to start')
    expect(calls.map(agentOf)).toEqual(['ui', 'ps'])
    live[0].finish()
    await until(() => modInputs.length === 2, "ui's reply to be routed")
    live[1].finish()
    await until(() => modInputs.length === 3, "the moderator call for ps's reply")
    // ps's reply is not routed yet, so wk still waits
    const waiting = (await metaOf(c.id)).group
    expect(waiting.queue).toEqual([{ agent: 'wk', after: ['ui', 'ps'] }])
    expect(waiting.active).toEqual([])
    expect(calls).toHaveLength(2)
    routePs(none())
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'ps', 'wk'])
    expect(calls[2].stdin).toContain('<message from="ui" name="Ui">ui done</message>')
    expect(calls[2].stdin).toContain('<message from="ps" name="Ps">ps done</message>')
  })

  it('a member mentioned while working runs again after its turn', async () => {
    const c = await group()
    modAnswers = [par('ui')]
    scripts.ui = [
      { hang: true, events: replyEvents('ui', 'first') },
      { hang: true, events: replyEvents('ui', 'second') }
    ]
    await svc.send(c.id, '@ui go')
    await until(() => calls.length === 1, 'ui to start')
    await svc.send(c.id, '@ui more')
    // the message is in the thread at once
    expect((await store.loadItems(c.id)).filter((i) => i.type === 'user').map((i) => (i as { text: string }).text)).toEqual([
      '@ui go',
      '@ui more'
    ])
    await until(() => lastGroup(c.id)?.queue.length === 1, 'ui to be queued again')
    expect(lastGroup(c.id)?.queue).toEqual([{ agent: 'ui', after: ['ui'] }])
    expect(calls).toHaveLength(1)
    live[0].finish()
    await until(() => calls.length === 2, "ui's second turn")
    live[1].finish()
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'ui'])
    expect(calls[1].stdin).toContain('<message from="user">@ui more</message>')
    expect(calls[1].stdin).not.toContain('@ui go')
    expect(calls[1].stdin.endsWith('The user mentioned you\nGive a real reply.')).toBe(true)
    // the queue never held two turns of one member at once
    expect(groupsPushed(c.id).every((g) => g.active.filter((t) => t.agent === 'ui').length <= 1)).toBe(true)
  })

  it('the moderator routes a reply while other members keep working', async () => {
    const c = await group()
    modAnswers = [par('ui', 'wk'), par('ps')]
    scripts.wk = [{ hang: true }]
    await svc.send(c.id, '@ui @wk go')
    await until(() => calls.length === 3, 'ps to start while wk works')
    expect(calls.map(agentOf)).toEqual(['ui', 'wk', 'ps'])
    expect(modInputs[1]).toMatchObject({ speaker: 'ui', working: ['wk'] })
    expect(chats.isRunning(c.id)).toBe(true)
    live[1].finish()
    await idle(c.id)
    expect(assistants(await store.loadItems(c.id)).map((i) => i.agent)).toEqual(['ui', 'ps', 'wk'])
  })

  const heldNotices = async (id: string) =>
    (await store.loadItems(id)).filter((i) => i.type === 'notice' && i.kind === 'held').map((i) => (i as { text: string }).text)

  it('a moderator skip keeps an agent from running again for a mention that only agrees', async () => {
    const c = await group()
    modAnswers = [par('ps'), { next: [], drop: [], skip: ['ui'], askUser: false }]
    scripts.ps = [{ text: '@ui is correct, we continue' }]
    await svc.send(c.id, '@ps go')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ps'])
    expect((await metaOf(c.id)).group.queue).toEqual([])
  })

  it('a skipped mention leaves the reason of a member the moderator queued, so it may still pass', async () => {
    const c = await group()
    modAnswers = [
      { next: [pick('wk'), pick('ui', ['wk'])], drop: [], skip: [], askUser: false },
      { next: [], drop: [], skip: ['ui'], askUser: false }
    ]
    scripts.wk = [{ text: '@ui is correct, we continue' }]
    await svc.send(c.id, '@wk go')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['wk', 'ui'])
    expect(calls[1].stdin).toContain('exactly ' + PASS_MARKER)
  })

  it('askUser drops a member the user asked for and says it waits for the answer', async () => {
    const c = await group()
    modAnswers = [
      par('wk'),
      { next: [pick('ui', ['wk'])], drop: [], skip: [], askUser: false },
      { next: [], drop: ['ui'], skip: [], askUser: true }
    ]
    scripts.wk = [{ hang: true }]
    await svc.send(c.id, '@wk go')
    await until(() => calls.length === 1, 'wk to start')
    await svc.send(c.id, '@ui thanks')
    await until(() => lastGroup(c.id)?.queue.some((e) => e.agent === 'ui') === true, 'ui to be queued')
    live[0].finish()
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['wk'])
    expect((await metaOf(c.id)).group.queue).toEqual([])
    expect(await heldNotices(c.id)).toEqual([`${displayName('ui')} waits for your answer.`])
  })

  it('without askUser the member the user asked for still runs and no notice is added', async () => {
    const c = await group()
    modAnswers = [
      par('wk'),
      { next: [pick('ui', ['wk'])], drop: [], skip: [], askUser: false },
      { next: [], drop: ['ui'], skip: [], askUser: false }
    ]
    scripts.wk = [{ hang: true }]
    await svc.send(c.id, '@wk go')
    await until(() => calls.length === 1, 'wk to start')
    await svc.send(c.id, '@ui thanks')
    await until(() => lastGroup(c.id)?.queue.some((e) => e.agent === 'ui') === true, 'ui to be queued')
    live[0].finish()
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['wk', 'ui'])
    expect(await heldNotices(c.id)).toEqual([])
  })

  it('askUser also holds an agent-queued member with the notice', async () => {
    const c = await group()
    modAnswers = [seq('ui', 'wk'), { next: [], drop: ['wk'], skip: [], askUser: true }]
    scripts.ui = [{ text: 'Should we keep the old flow? Please decide.' }]
    await svc.send(c.id, '@ui check it, then wk merges')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui'])
    expect((await metaOf(c.id)).group.queue).toEqual([])
    expect(await heldNotices(c.id)).toEqual([`${displayName('wk')} waits for your answer.`])
  })

  it('drop takes a queued member off before it acts', async () => {
    const c = await group()
    modAnswers = [seq('ui', 'wk'), { next: [], drop: ['wk'], skip: [], askUser: false }]
    scripts.ui = [{ text: 'Should we keep the old flow? Please decide.' }]
    await svc.send(c.id, '@ui check it, then wk merges')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui'])
    expect(modInputs[1]).toMatchObject({ speaker: 'ui', queue: [{ agent: 'wk', after: ['ui'] }] })
    expect((await metaOf(c.id)).group.queue).toEqual([])
  })

  it('a member the user asked for is not dropped by the routing of another reply', async () => {
    const c = await group()
    modAnswers = [
      par('wk'),
      { next: [pick('ui', ['wk'])], drop: [], skip: [], askUser: false },
      { next: [], drop: ['ui'], skip: [], askUser: false }
    ]
    scripts.wk = [{ hang: true }]
    await svc.send(c.id, '@wk go')
    await until(() => calls.length === 1, 'wk to start')
    await svc.send(c.id, '@ui thanks')
    await until(() => lastGroup(c.id)?.queue.some((e) => e.agent === 'ui') === true, 'ui to be queued')
    live[0].finish()
    await idle(c.id)
    expect(modInputs[2]).toMatchObject({ speaker: 'wk', queue: [{ agent: 'ui', after: ['wk'] }] })
    expect(calls.map(agentOf)).toEqual(['wk', 'ui'])
    expect(calls[1].stdin.endsWith('The user mentioned you\nGive a real reply.')).toBe(true)
  })

  it('a member picked to answer the user is not dropped by the routing of another reply', async () => {
    const c = await group()
    modAnswers = [
      par('wk'),
      { next: [pick('ps', ['wk'])], drop: [], skip: [], askUser: false },
      { next: [], drop: ['ps'], skip: [], askUser: false }
    ]
    scripts.wk = [{ hang: true }]
    await svc.send(c.id, '@wk go')
    await until(() => calls.length === 1, 'wk to start')
    await svc.send(c.id, 'anyone else?')
    await until(() => lastGroup(c.id)?.queue.some((e) => e.agent === 'ps') === true, 'ps to be queued')
    live[0].finish()
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['wk', 'ps'])
    expect(calls[1].stdin.endsWith("The user's message is for the group; please answer it.\nGive a real reply.")).toBe(true)
  })

  it("a member queued by another member, then mentioned by the user, is the user's request", async () => {
    const c = await group()
    modAnswers = [
      par('ui', 'ps'),
      { next: [pick('wk', ['ps'])], drop: [], skip: [], askUser: false },
      none(),
      { next: [], drop: ['wk'], skip: [], askUser: false }
    ]
    scripts.ui = [{ text: '@wk merge it once ps is done' }]
    scripts.ps = [{ hang: true }]
    await svc.send(c.id, '@ui @ps go')
    await until(() => lastGroup(c.id)?.queue.some((e) => e.agent === 'wk') === true, 'wk to be queued by ui')
    await svc.send(c.id, '@wk yes, please merge it')
    await until(() => modInputs.length === 3, "the moderator call for the user's message")
    live[calls.findIndex((o) => agentOf(o) === 'ps')].finish()
    await idle(c.id)
    expect(modInputs[3]).toMatchObject({ speaker: 'ps', queue: [{ agent: 'wk', after: ['ps'] }] })
    expect(calls.map(agentOf)).toEqual(['ui', 'ps', 'wk'])
    expect(calls[2].stdin.endsWith('The user mentioned you\nGive a real reply.')).toBe(true)
  })

  it('a member queued by another member is still dropped when the user must decide', async () => {
    const c = await group()
    modAnswers = [
      par('ui', 'ps'),
      { next: [pick('wk', ['ps'])], drop: [], skip: [], askUser: false },
      { next: [], drop: ['wk'], skip: [], askUser: false }
    ]
    scripts.ui = [{ text: '@wk merge it once ps is done' }]
    scripts.ps = [{ hang: true, events: replyEvents('ps', 'The checks disagree. Which one do you want?') }]
    await svc.send(c.id, '@ui @ps go')
    await until(() => lastGroup(c.id)?.queue.some((e) => e.agent === 'wk') === true, 'wk to be queued by ui')
    live[calls.findIndex((o) => agentOf(o) === 'ps')].finish()
    await idle(c.id)
    expect(modInputs[2]).toMatchObject({ speaker: 'ps', queue: [{ agent: 'wk', after: ['ps'] }] })
    expect(calls.map(agentOf)).toEqual(['ui', 'ps'])
    expect((await metaOf(c.id)).group.queue).toEqual([])
  })

  it('a failed turn stops new starts but lets working members finish', async () => {
    const c = await group()
    modAnswers = [{ next: [pick('ui'), pick('wk'), pick('ps', ['ui', 'wk'])], drop: [], skip: [], askUser: false }]
    scripts.ui = [failing]
    scripts.wk = [{ hang: true, events: replyEvents('wk', '@ps over to you') }]
    await svc.send(c.id, '@ui @wk go')
    await until(() => calls.length === 2, 'ui and wk to start')
    live[0].finish()
    await until(() => lastGroup(c.id)?.queue.length === 0 && lastGroup(c.id)?.active.length === 1, 'the queue to clear')
    expect(chats.isRunning(c.id)).toBe(true)
    live[1].finish()
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'wk'])
    // wk's reply is posted but not routed
    expect(modInputs).toHaveLength(1)
    const items = await store.loadItems(c.id)
    expect(items.map((i) => i.type)).toEqual(['user', 'error', 'assistant'])
    expect(items[1]).toMatchObject({ type: 'error', text: 'Claude exited with code 1' })
    expect(items[2]).toMatchObject({ agent: 'wk', text: '@ps over to you' })
    const meta = await metaOf(c.id)
    expect(meta.group.queue).toEqual([])
    expect(meta.group.active).toEqual([])
    expect(meta.inFlight).toBe(false)
  })

  it('a failed turn cancels the routing of a reply that finished before it', async () => {
    const c = await group()
    modAnswers = [par('ui', 'wk'), 'hang']
    scripts.wk = [failing]
    await svc.send(c.id, '@ui @wk go')
    await until(() => modInputs.length === 2, "the moderator call for ui's reply")
    live[calls.findIndex((o) => agentOf(o) === 'wk')].finish()
    await idle(c.id)
    expect(modSignals[1].aborted).toBe(true)
    expect(calls.map(agentOf)).toEqual(['ui', 'wk'])
    const items = await store.loadItems(c.id)
    expect(items.map((i) => i.type)).toEqual(['user', 'assistant', 'error'])
    expect((await metaOf(c.id)).group.queue).toEqual([])
  })

  it('a wait on a member that finished while the moderator ran holds until its reply is routed', async () => {
    const c = await group()
    let routePs: (a: ModeratorAnswer) => void = () => {}
    modAnswers = [par('ui', 'ps')]
    modFallback = (input) =>
      input.speaker === 'ps'
        ? new Promise<ModeratorAnswer>((resolve) => {
            routePs = resolve
          })
        : 'hang'
    scripts.ui = [{ hang: true }]
    scripts.ps = [{ hang: true }]
    await svc.send(c.id, '@ui @ps go')
    await until(() => calls.length === 2, 'ui and ps to start')
    live[calls.findIndex((o) => agentOf(o) === 'ps')].finish()
    await until(() => modInputs.length === 2, "the moderator call for ps's reply")
    live[calls.findIndex((o) => agentOf(o) === 'ui')].finish()
    await until(() => posted(c.id, (i) => i.type === 'assistant' && i.agent === 'ui'), "ui's turn to end")
    // the moderator, called while ui still worked, makes wk wait for ui
    routePs({ next: [pick('wk', ['ui'])], drop: [], skip: [], askUser: false })
    await until(() => modInputs.length === 3, "the moderator call for ui's reply")
    expect((await metaOf(c.id)).group.queue).toEqual([{ agent: 'wk', after: ['ui'] }])
    expect(calls.map(agentOf)).toEqual(['ui', 'ps'])
    chats.stop(c.id)
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'ps'])
  })

  it('stop clears the stored queue at once, while working members still wind down', async () => {
    const c = await group()
    modAnswers = [seq('ui', 'wk')]
    scripts.ui = [{ hang: true, stubborn: true }]
    await svc.send(c.id, '@ui @wk go')
    await until(() => calls.length === 1, 'ui to start')
    expect((await metaOf(c.id)).group.queue.map((e) => e.agent)).toEqual(['wk'])
    chats.stop(c.id)
    await until(() => lastGroup(c.id)?.queue.length === 0, 'the pushed queue to clear')
    expect(chats.isRunning(c.id)).toBe(true)
    const draining = (await metaOf(c.id)).group
    expect(draining.queue).toEqual([])
    expect(draining.active.map((t) => t.agent)).toEqual(['ui'])
    live[0].finish()
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui'])
    expect(notices(await store.loadItems(c.id)).map((i) => i.kind)).toEqual(['stopped'])
  })

  it('a member stopped by the usage limit is named on the posted error', async () => {
    const c = await group()
    modAnswers = [par('ui')]
    scripts.ui = [{ events: [{ kind: 'limited', resetsAt: 9_000 }], outcome: { exitCode: 1, result: null } }]
    await svc.send(c.id, '@ui go')
    await until(() => posted(c.id, (i) => i.type === 'error'), "ui's limited turn to end")
    await idle(c.id)
    expect((await store.loadItems(c.id)).find((i) => i.type === 'error')).toMatchObject({ limit: { resetsAt: 9_000, agent: 'ui' } })
  })

  it('a user message routed while a member fails still gets its answer', async () => {
    const c = await group()
    let routeUser: (a: ModeratorAnswer) => void = () => {}
    modAnswers = [
      par('ui', 'wk'),
      new Promise<ModeratorAnswer>((resolve) => {
        routeUser = resolve
      })
    ]
    scripts.ui = [failing]
    scripts.wk = [{ hang: true }]
    await svc.send(c.id, '@ui @wk go')
    await until(() => calls.length === 2, 'ui and wk to start')
    await svc.send(c.id, '@ps what do you think?')
    await until(() => modInputs.length === 2, "the moderator call for the user's message")
    live[calls.findIndex((o) => agentOf(o) === 'ui')].finish()
    await until(() => posted(c.id, (i) => i.type === 'error'), "ui's failed turn to end")
    routeUser(par('ps'))
    await until(() => calls.length === 3, 'ps to answer')
    expect(agentOf(calls[2])).toBe('ps')
    expect(calls[2].stdin.endsWith('The user mentioned you\nGive a real reply.')).toBe(true)
    expect(modSignals[1].aborted).toBe(false)
    live[calls.findIndex((o) => agentOf(o) === 'wk')].finish()
    await idle(c.id)
    // ps's reply is routed; wk worked through the failure, so its reply is not
    expect(modInputs.map((i) => i.speaker)).toEqual([null, null, 'ps'])
  })

  it('a user message waiting to be routed survives a failure; a member reply being routed does not', async () => {
    const c = await group()
    modAnswers = [par('ui', 'wk', 'ps'), 'hang', par('ps')]
    scripts.ui = [failing]
    scripts.wk = [{ hang: true }]
    await svc.send(c.id, '@ui @wk @ps go')
    await until(() => modInputs.length === 2, "the moderator call for ps's reply")
    await svc.send(c.id, '@ps again') // waits behind ps's reply
    live[calls.findIndex((o) => agentOf(o) === 'ui')].finish()
    await until(() => calls.length === 4, 'ps to answer the user')
    expect(modSignals[1].aborted).toBe(true)
    expect(modInputs[2]).toMatchObject({ speaker: null, mentioned: ['ps'] })
    expect(calls[3].stdin.endsWith('The user mentioned you\nGive a real reply.')).toBe(true)
    live[calls.findIndex((o) => agentOf(o) === 'wk')].finish()
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'wk', 'ps', 'ps'])
    expect(modInputs.map((i) => i.speaker)).toEqual([null, 'ps', null, 'ps'])
  })

  it('a user message after a failure starts the room again', async () => {
    const c = await group()
    modAnswers = [par('ui', 'wk'), par('ps')]
    scripts.ui = [failing]
    scripts.wk = [{ hang: true, events: replyEvents('wk', '@ui over to you') }]
    await svc.send(c.id, '@ui @wk go')
    await until(() => calls.length === 2, 'ui and wk to start')
    live[0].finish()
    await until(() => posted(c.id, (i) => i.type === 'error'), "ui's failed turn to end")
    // wk still works; the user's message joins the halted room
    await svc.send(c.id, '@ps check it')
    await until(() => calls.length === 3, 'ps to start')
    expect(agentOf(calls[2])).toBe('ps')
    live[1].finish()
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'wk', 'ps'])
    // wk worked through the failure, so its reply is not routed; ps's is
    expect(modInputs.map((i) => i.speaker)).toEqual([null, null, 'ps'])
  })

  it('stop halts every working member with a stopped notice each', async () => {
    const c = await group()
    modAnswers = [{ next: [pick('ui'), pick('wk'), pick('ps', ['ui', 'wk'])], drop: [], skip: [], askUser: false }]
    scripts.ui = [{ hang: true }]
    scripts.wk = [{ hang: true }]
    await svc.send(c.id, '@ui @wk go')
    await until(() => calls.length === 2, 'ui and wk to start')
    chats.stop(c.id)
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'wk'])
    const items = await store.loadItems(c.id)
    expect(notices(items).map((i) => i.kind)).toEqual(['stopped', 'stopped'])
    expect(items.some((i) => 'turn' in i)).toBe(false)
    const meta = await metaOf(c.id)
    expect(meta.group.queue).toEqual([])
    expect(meta.group.active).toEqual([])
    expect(meta.inFlight).toBe(false)
    expect(chats.runningCount()).toBe(0)
  })

  it('the cap counts members that ran side by side', async () => {
    const c = await group()
    fallback = (a) => ({ text: a === 'ui' ? '@wk @ps more' : a === 'wk' ? '@ui @ps more' : '@ui @wk more' })
    modFallback = (input) => par(...input.mentioned)
    await svc.send(c.id, '@ui @wk go')
    await idle(c.id)
    expect(calls).toHaveLength(15)
    expect(groupsPushed(c.id).some((g) => g.active.length > 1)).toBe(true)
    const items = await store.loadItems(c.id)
    expect(notices(items).filter((i) => i.kind === 'paused')).toHaveLength(1)
    expect(items[items.length - 1]).toMatchObject({ type: 'notice', kind: 'paused' })
    expect((await metaOf(c.id)).group.queue).toEqual([])
  })

  it('a role saved mid-run reaches the next turn only', async () => {
    const c = await group()
    modAnswers = [seq('ui', 'wk')]
    scripts.ui = [{ hang: true }]
    await svc.send(c.id, '@ui @wk go')
    await until(() => calls.length === 1, 'ui to start')
    const meta = await svc.setRole(c.id, 'Ui reviews first, then wk merges.')
    expect(meta.group?.role).toBe('Ui reviews first, then wk merges.')
    expect(pushes).toContainEqual({ chatId: c.id, kind: 'meta', meta })
    live[0].finish()
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'wk'])
    expect(argAfter(calls[0].args, '--append-system-prompt')).not.toContain('Ui reviews first')
    expect(argAfter(calls[1].args, '--append-system-prompt')).toContain('Ui reviews first, then wk merges.')
    expect((await metaOf(c.id)).group.role).toBe('Ui reviews first, then wk merges.')
    const single = await store.create('ui', dir)
    await expect(svc.setRole(single.id, 'x')).rejects.toThrow()
  })

  it('a room handoff reaches the member on a first turn and on a reseeded turn', async () => {
    const c = await group(['ui', 'wk'])
    const handoff = { text: 'We chose SQLite.', from: { chatId: 'old', title: 'Old room' }, at: 5 }
    await store.updateGroup(c.id, (g) => ({ ...g, handoff, sessions: { ui: 'old' }, seen: {} }))
    modAnswers = [seq('ui')]
    scripts.ui = [
      { events: [], outcome: { exitCode: 1, stderr: 'No conversation found with session ID: old', result: null } },
      { text: 'back' }
    ]
    await svc.send(c.id, '@ui go')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'ui'])
    expect(calls[1].args).not.toContain('--resume')
    for (const call of calls) expect(argAfter(call.args, '--append-system-prompt')).toContain('<handoff>\nWe chose SQLite.\n</handoff>')
  })

  it('a turn message leaves out live text of members still working', async () => {
    const c = await group()
    modAnswers = [par('ui', 'wk'), par('ps')]
    scripts.ui = [{ hang: true }]
    scripts.wk = [{ hang: true }]
    await svc.send(c.id, '@ui @wk go')
    await until(() => calls.length === 2, 'ui and wk to start')
    live[1].emit({ kind: 'assistantText', text: 'wk partial' })
    live[0].finish()
    await until(() => calls.length === 3, 'ps to start')
    expect(calls[2].stdin).toContain('<message from="ui" name="Ui">ui done</message>')
    expect(calls[2].stdin).not.toContain('wk partial')
    expect(modInputs[1].messages.map((m) => m.text)).not.toContain('wk partial')
    live[1].finish()
    await idle(c.id)
  })

  it('a reseed leaves out live text of members still working', async () => {
    const c = await group(['ui', 'wk'])
    modAnswers = [par('wk'), par('ui'), none(), par('ui')]
    scripts.wk = [{ hang: true }]
    scripts.ui = [
      { text: 'ui first' },
      { events: [], outcome: { exitCode: 1, stderr: 'No conversation found with session ID: s-ui', result: null } },
      { text: 'back' }
    ]
    await svc.send(c.id, '@wk go')
    await until(() => calls.length === 1, 'wk to start')
    live[0].emit({ kind: 'assistantText', text: 'wk partial' })
    // ui's first turn marks the thread seen past wk's live text
    await svc.send(c.id, '@ui one')
    await until(() => modInputs.length === 3, "ui's first reply to be routed")
    await svc.send(c.id, '@ui two')
    await until(() => calls.length === 4, 'ui to reseed')
    const seed = calls[3].stdin
    expect(seed.startsWith("[ZumiBot] This chat's earlier session expired")).toBe(true)
    expect(seed).toContain('User: @ui one')
    expect(seed).not.toContain('wk partial')
    live[0].finish()
    await idle(c.id)
  })

  it('the moderator sees the role, who is working and the queue', async () => {
    const c = await store.createGroup(['ui', 'wk', 'ps'], dir, 'Ui and wk review; ps merges after both.')
    modAnswers = [{ next: [pick('ui'), pick('wk'), pick('ps', ['ui', 'wk'])], drop: [], skip: [], askUser: false }]
    scripts.wk = [{ hang: true }]
    await svc.send(c.id, '@ui @wk review')
    await until(() => modInputs.length === 2, "ui's reply to be routed")
    expect(modInputs[0]).toMatchObject({ role: 'Ui and wk review; ps merges after both.', working: [], queue: [] })
    expect(modInputs[1]).toMatchObject({
      speaker: 'ui',
      role: 'Ui and wk review; ps merges after both.',
      working: ['wk'],
      queue: [{ agent: 'ps', after: ['ui', 'wk'] }]
    })
    expect(argAfter(calls[0].args, '--append-system-prompt')).toContain('Ui and wk review; ps merges after both.')
    live[1].finish()
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'wk', 'ps'])
  })

  it('a pass from a member that ran side by side leaves no trace', async () => {
    const c = await group()
    modAnswers = [par('ui', 'ps')]
    scripts.ui = [{ hang: true }]
    scripts.ps = [
      {
        hang: true,
        events: [
          { kind: 'toolResult', toolUseId: 'tp1', content: 'ok', isError: false },
          { kind: 'assistantText', text: '[[PASS]]' },
          okResult
        ]
      }
    ]
    await svc.send(c.id, '@ui check this')
    await until(() => calls.length === 2, 'ui and ps to start')
    live[1].emit({ kind: 'toolUse', id: 'tp1', name: 'Read', input: { file_path: '/p' } })
    live[0].emit({ kind: 'toolUse', id: 'tu1', name: 'Read', input: { file_path: '/u' } })
    live[1].finish()
    await until(
      () =>
        lastGroup(c.id)
          ?.active.map((t) => t.agent)
          .join() === 'ui',
      "ps's turn to end"
    )
    live[0].finish()
    await idle(c.id)
    const items = await store.loadItems(c.id)
    expect(items.filter((i) => 'agent' in i && i.agent === 'ps')).toEqual([])
    expect(items.map((i) => i.type)).toEqual(['user', 'tool', 'assistant'])
    expect(modInputs.map((i) => i.speaker)).toEqual([null, 'ui'])
    expect((await metaOf(c.id)).group.seen.ps).toBe(items[0].id)
  })
})

describe('GroupService agent renames', () => {
  // What the app does when an agent file is renamed: the live rooms first, then the stored chats.
  const rename = async (from: string, to: string) => {
    agentList = agentList.map((a) => (a.name === from ? agentSummary(to) : a))
    svc.renameAgent(from, to)
    await store.renameAgent(from, to)
  }
  const authors = (items: ChatItem[]) => items.flatMap((i) => ('agent' in i && i.agent ? [[i.type, i.agent]] : []))

  it('a rename while the room runs reaches the saved log, the group and a queued reason', async () => {
    const c = await group()
    await store.saveItems(c.id, [
      { type: 'user', id: 'u0', text: 'earlier', ts: 1 },
      { type: 'assistant', id: 'b0', text: 'wk earlier', ts: 2, agent: 'wk' }
    ])
    await store.updateGroup(c.id, (g) => ({ ...g, sessions: { wk: 'w1' }, seen: { wk: 'b0' } }))
    modAnswers = [seq('ui', 'wk')]
    scripts.ui = [{ hang: true }]
    scripts.writer = [{ text: '[[PASS]]' }] // a mentioned member's pass is shown
    await svc.send(c.id, '@ui @wk go')
    await until(() => calls.length === 1, 'ui to start')
    live[0].emit({ kind: 'toolUse', id: 't1', name: 'Read', input: { file_path: '/x' } })
    await rename('ui', 'designer') // the running member
    await rename('wk', 'writer') // a queued member
    live[0].finish()
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'writer'])
    expect(calls[1].stdin.endsWith('The user mentioned you\nGive a real reply.')).toBe(true)
    expect(modInputs[1]).toMatchObject({ speaker: 'designer', queue: [expect.objectContaining({ agent: 'writer' })] })
    const items = await store.loadItems(c.id)
    expect(authors(items)).toEqual([
      ['assistant', 'writer'],
      ['tool', 'designer'],
      ['assistant', 'designer'],
      ['assistant', 'writer']
    ])
    expect(assistants(items).map((i) => i.text)).toEqual(['wk earlier', 'ui done', '[[PASS]]'])
    const meta = await metaOf(c.id)
    expect(meta.group.members).toEqual(['designer', 'writer', 'ps'])
    expect(meta.group.sessions).toEqual({ designer: 's-ui', writer: 's-writer' })
    expect(Object.keys(meta.group.seen).sort()).toEqual(['designer', 'writer'])
    expect(meta.group.queue).toEqual([])
    expect(meta.group.active).toEqual([])
  })

  it('a working member renamed mid-turn finishes under its new name', async () => {
    const c = await group()
    modAnswers = [par('ui', 'wk')]
    scripts.ui = [{ hang: true }]
    scripts.wk = [{ hang: true }]
    await svc.send(c.id, '@ui @wk go')
    await until(() => calls.length === 2, 'ui and wk to start')
    live[0].emit({ kind: 'toolUse', id: 't1', name: 'Read', input: { file_path: '/x' } })
    await rename('ui', 'designer')
    expect((await metaOf(c.id)).group.active.map((t) => t.agent)).toEqual(['designer', 'wk'])
    live[0].finish()
    await until(() => modInputs.length === 2, "designer's reply to be routed")
    expect(modInputs[1]).toMatchObject({ speaker: 'designer', working: ['wk'] })
    live[1].finish()
    await idle(c.id)
    const items = await store.loadItems(c.id)
    expect(authors(items)).toEqual([
      ['tool', 'designer'],
      ['assistant', 'designer'],
      ['assistant', 'wk']
    ])
    expect(items.some((i) => 'turn' in i)).toBe(false)
    const meta = await metaOf(c.id)
    expect(meta.group.sessions).toEqual({ designer: 's-ui', wk: 's-wk' })
    expect(Object.keys(meta.group.seen).sort()).toEqual(['designer', 'wk'])
    expect(meta.group.active).toEqual([])
  })

  it('a queued reason names the mentioning member by its new name', async () => {
    const c = await group()
    modAnswers = [seq('ui', 'ps'), { next: [pick('wk', ['ps'])], drop: [], skip: [], askUser: false }]
    scripts.ui = [{ text: '@wk do it' }]
    scripts.ps = [{ hang: true }]
    await svc.send(c.id, '@ui @ps go')
    await until(() => calls.length === 2, 'ps to start')
    expect((await metaOf(c.id)).group.queue.map((e) => e.agent)).toEqual(['wk'])
    await rename('ui', 'designer')
    live[1].finish()
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'ps', 'wk'])
    expect(calls[2].stdin.endsWith('You were mentioned by @designer\nIf it asks nothing of you, reply with exactly [[PASS]].')).toBe(true)
  })

  it('a reply waiting to be routed follows a rename', async () => {
    const c = await group()
    let answer: (v: ModeratorAnswer) => void = () => {}
    modAnswers = [
      seq('ui'),
      new Promise<ModeratorAnswer>((resolve) => {
        answer = resolve
      }),
      seq('ps')
    ]
    scripts.ui = [{ hang: true, events: replyEvents('ui', '@ps over to you') }]
    await svc.send(c.id, '@ui go')
    await until(() => calls.length === 1, 'ui to start')
    await svc.send(c.id, '@wk also this') // routed before ui's reply
    live[0].finish()
    await until(() => modInputs.length === 2, 'the moderator call for the mid-turn message')
    await rename('ui', 'designer')
    answer(seq('wk'))
    await idle(c.id)
    expect(modInputs[2]).toMatchObject({ speaker: 'designer', mentioned: ['ps'] })
    expect(calls.map(agentOf)).toEqual(['ui', 'wk', 'ps'])
    expect(calls[2].stdin.endsWith('You were mentioned by @designer\nIf it asks nothing of you, reply with exactly [[PASS]].')).toBe(true)
  })

  it('a rename while the moderator runs routes by the new name', async () => {
    const c = await group()
    let answer: (v: ModeratorAnswer) => void = () => {}
    modAnswers = [
      new Promise<ModeratorAnswer>((resolve) => {
        answer = resolve
      })
    ]
    await svc.send(c.id, '@ui go')
    await until(() => modInputs.length === 1, 'the moderator call')
    await rename('ui', 'designer')
    answer(seq('ui')) // the moderator answers with the handle it was given
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['designer'])
    expect(calls[0].stdin.endsWith('The user mentioned you\nGive a real reply.')).toBe(true)
    const items = await store.loadItems(c.id)
    expect(items.some((i) => i.type === 'notice')).toBe(false)
    expect((await metaOf(c.id)).group.sessions).toEqual({ designer: 's-designer' })
  })

  it('a rename while a command waits to be routed follows it', async () => {
    const c = await group()
    let answer: (v: ModeratorAnswer) => void = () => {}
    modAnswers = [
      new Promise<ModeratorAnswer>((resolve) => {
        answer = resolve
      }),
      par('wk2')
    ]
    await svc.send(c.id, '@ui go')
    await until(() => modInputs.length === 1, 'the moderator call for the first message')
    await svc.send(c.id, '/check L', [], undefined, undefined, { agent: 'wk', name: 'check', prompt: 'Use check on L' }) // waits in the inbox
    await rename('wk', 'wk2')
    answer(none())
    await idle(c.id)
    expect(modInputs[1].mentioned).toEqual(['wk2'])
    expect(calls.map(agentOf)).toEqual(['ui', 'wk2'])
    expect(calls[1].stdin).toContain('Use check on L')
    expect((await store.loadItems(c.id)).find((i) => i.type === 'user' && i.text === '/check L')).toMatchObject({
      command: { agent: 'wk2', name: 'check' }
    })
  })

  it('the last speaker follows a rename', async () => {
    const c = await group(['wk', 'ui', 'ps'])
    await store.saveItems(c.id, [
      { type: 'user', id: 'u0', text: 'hi', ts: 1 },
      { type: 'assistant', id: 'a0', text: 'from ui', ts: 2, agent: 'ui' }
    ])
    let answer: (v: null) => void = () => {}
    modAnswers = [
      new Promise<null>((resolve) => {
        answer = resolve
      })
    ]
    await svc.send(c.id, 'hello')
    await until(() => modInputs.length === 1, 'the moderator call')
    await rename('ui', 'designer')
    answer(null) // the moderator failed: the last speaker answers
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['designer'])
    const items = await store.loadItems(c.id)
    expect(items).toContainEqual(
      expect.objectContaining({ kind: 'moderator', text: "Couldn't check who else should reply, so Designer answers." })
    )
  })

  it('a rename while the room loads its items is not saved over', async () => {
    const c = await group()
    await store.saveItems(c.id, [{ type: 'assistant', id: 'b0', text: 'wk earlier', ts: 2, agent: 'wk' }])
    const update = store.update.bind(store)
    let renamed: Promise<void> | null = null
    store.update = async (id, patch) => {
      // The room has read the items but is not running yet.
      if (patch.inFlight === true && renamed === null) renamed = rename('wk', 'writer')
      return update(id, patch)
    }
    modAnswers = [seq('ui')]
    await svc.send(c.id, '@ui go')
    await renamed
    await idle(c.id)
    expect(authors(await store.loadItems(c.id))).toEqual([
      ['assistant', 'writer'],
      ['assistant', 'ui']
    ])
  })

  describe('@everyone', () => {
    it('the first member added must answer, the next gets the everyone reason and may pass', async () => {
      const c = await group()
      modAnswers = [{ next: [pick('wk'), pick('ui', ['wk'])], drop: [], skip: [], askUser: false }]
      scripts.ui = [{ text: '[[PASS]]' }]
      await svc.send(c.id, '@everyone go')
      await idle(c.id)
      expect(modInputs[0]).toMatchObject({ everyone: true, mentioned: [] })
      expect(calls.map(agentOf)).toEqual(['wk', 'ui'])
      expect(calls[0].stdin.endsWith("The user's message is for the group; please answer it.\nGive a real reply.")).toBe(true)
      expect(
        calls[1].stdin.endsWith("The user's message is for everyone in the group.\nIf it asks nothing of you, reply with exactly [[PASS]].")
      ).toBe(true)
      const items = await store.loadItems(c.id)
      expect(assistants(items).map((i) => i.agent)).toEqual(['wk'])
    })

    it('an agent reply with @everyone has no effect', async () => {
      const c = await group()
      modAnswers = [par('wk'), none()]
      scripts.wk = [{ text: '@everyone look at this' }]
      await svc.send(c.id, '@wk go')
      await idle(c.id)
      expect(modInputs[1]).toMatchObject({ speaker: 'wk', everyone: false, mentioned: [] })
      expect(calls.map(agentOf)).toEqual(['wk'])
    })

    it('an everyone-queued member is protected from drop unless askUser', async () => {
      const c = await group()
      modAnswers = [
        { next: [pick('wk'), pick('ui', ['wk'])], drop: [], skip: [], askUser: false },
        { next: [pick('ps')], drop: ['ui'], skip: [], askUser: false }
      ]
      scripts.wk = [{ hang: true }]
      scripts.ui = [{ text: 'ui here' }]
      await svc.send(c.id, '@everyone go')
      await until(() => calls.length === 1, 'wk to start')
      await svc.send(c.id, '@ps wait, never mind')
      await until(() => calls.length === 2, 'ps to start from the second message')
      live[0].finish()
      await idle(c.id)
      expect(calls.map(agentOf).sort()).toEqual(['ps', 'ui', 'wk'])

      const d = await group()
      modAnswers = [
        { next: [pick('wk'), pick('ui', ['wk'])], drop: [], skip: [], askUser: false },
        { next: [pick('ps')], drop: ['ui'], skip: [], askUser: true }
      ]
      scripts.wk = [{ hang: true }]
      const before = calls.length
      await svc.send(d.id, '@everyone go')
      await until(() => calls.length === before + 1, 'wk to start')
      await svc.send(d.id, '@ps which one?')
      await until(() => calls.length === before + 2, 'ps to start from the second message')
      live[before].finish()
      await idle(d.id)
      expect(calls.slice(before).map(agentOf)).toEqual(['wk', 'ps'])
      const held = (await store.loadItems(d.id))
        .filter((i) => i.type === 'notice' && i.kind === 'held')
        .map((i) => (i as { text: string }).text)
      expect(held).toEqual([`${displayName('ui')} waits for your answer.`])
    })

    it('no picks for @everyone runs all members side by side', async () => {
      const c = await group()
      modAnswers = [none()]
      scripts.ui = [{ hang: true }]
      scripts.wk = [{ hang: true }]
      scripts.ps = [{ hang: true }]
      await svc.send(c.id, '@everyone hi')
      await until(() => calls.length === 3, 'all three to start')
      expect(calls.map(agentOf).sort()).toEqual(['ps', 'ui', 'wk'])
      live.forEach((l) => l.finish())
      await idle(c.id)
    })

    it('a failed moderator chain: the first member must answer, the rest may pass', async () => {
      const c = await group()
      modAnswers = [null]
      await svc.send(c.id, '@everyone hi')
      await idle(c.id)
      expect(calls.map(agentOf)).toEqual(['ui', 'wk', 'ps'])
      expect(calls[0].stdin.endsWith("The user's message is for the group; please answer it.\nGive a real reply.")).toBe(true)
      for (const k of [1, 2]) {
        expect(
          calls[k].stdin.endsWith(
            "The user's message is for everyone in the group.\nIf it asks nothing of you, reply with exactly [[PASS]]."
          )
        ).toBe(true)
      }
    })

    it("a named member first in the plan is the user's request and nobody gets the answer reason", async () => {
      const c = await group()
      modAnswers = [none()]
      await svc.send(c.id, '@everyone @wk go')
      await idle(c.id)
      expect(calls.map(agentOf).sort()).toEqual(['ps', 'ui', 'wk'])
      const stdin = (a: string) => calls.find((x) => agentOf(x) === a)!.stdin
      expect(stdin('wk').endsWith('The user mentioned you\nGive a real reply.')).toBe(true)
      for (const a of ['ui', 'ps']) {
        expect(stdin(a)).toContain("The user's message is for everyone in the group.")
        expect(stdin(a)).not.toContain('please answer it')
      }
    })
  })
})

describe('browser handoff in parallel group turns', () => {
  it('keeps other member output, renames live metadata, and unstamps only the live group identity', async () => {
    let publish!: (handoff: BrowserHandoff) => Promise<void>
    let owner!: BrowserOwner
    const card = (): BrowserHandoff => ({
      ...owner,
      id: 'handoff',
      agent: 'ui',
      generation: 'generation',
      site: 'example.com',
      reason: 'Help',
      createdAt: 1000,
      status: 'pending'
    })
    chatDeps.browserTurns = {
      profileId: async (agent) => `profile-${agent}`,
      create: async (own, handoff) => {
        if (own.profileId === 'profile-ui') {
          owner = own
          publish = handoff
        }
        return {
          mcp: NO_MCP,
          args: [],
          env: {},
          prompt: 'Scoped browser instructions',
          dispose: async () => {
            if (own.profileId === 'profile-ui') await handoff({ ...card(), agent: 'renamed', status: 'interrupted' })
          }
        }
      }
    }
    const c = await group(['ui', 'wk'])
    scripts.ui = [{ hang: true }]
    scripts.wk = [{ text: 'other member reply' }]
    modAnswers = [par('ui', 'wk'), none()]
    await svc.send(c.id, 'work together')
    await until(() => calls.length === 2)
    await publish(card())
    await until(() => live.length === 2)
    svc.renameAgent('ui', 'renamed')
    chats.renameAgent('ui', 'renamed')
    await store.renameAgent('ui', 'renamed')
    await publish({ ...card(), agent: 'renamed' })
    expect(chats.pendingCount(c.id)).toBe(1)
    await until(() =>
      pushes.some((p) => p.kind === 'items' && p.items.some((i) => i.type === 'assistant' && i.text === 'other member reply'))
    )
    chats.stop(c.id)
    await idle(c.id)
    const items = await store.loadItems(c.id)
    expect(items).toContainEqual(expect.objectContaining({ type: 'assistant', text: 'other member reply' }))
    const saved = items.find((i) => i.type === 'browser-action')
    expect(saved).toMatchObject({
      agent: 'renamed',
      handoff: { agent: 'renamed', turnId: owner.turnId, profileId: 'profile-ui', status: 'interrupted' }
    })
    expect(saved).not.toHaveProperty('turn')
  })
})

describe('GroupService stamps, start points and rerun', () => {
  const turnOf = (session: string, text: string, tip: string): RunEvent[] => [
    { kind: 'init', sessionId: session, version: '2.1.299' },
    { kind: 'entry', uuid: tip },
    { kind: 'assistantText', text },
    okResult
  ]
  const end = (agent: string, session: string, at: string, seen: string | null) => ({ agent, session, at, seen })
  // u1, ui answers (a1), wk answers (a2), u2, ui answers (a3). Sessions as the last turns left them.
  const history = async (extra: ChatItem[] = [], members = ['ui', 'wk', 'ps']) => {
    const c = await group(members)
    const items: ChatItem[] = [
      { type: 'user', id: 'u1', text: 'first', ts: 1 },
      { type: 'assistant', id: 'a1', text: 'ui one', ts: 2, agent: 'ui', end: end('ui', 'sU1', 'e1', 'u1') },
      { type: 'assistant', id: 'a2', text: 'wk one', ts: 3, agent: 'wk', end: end('wk', 'sW1', 'f1', 'a1') },
      { type: 'user', id: 'u2', text: 'second', ts: 4 },
      { type: 'assistant', id: 'a3', text: 'OLD ui answer', ts: 5, agent: 'ui', end: end('ui', 'sU2', 'e2', 'u2') },
      ...extra
    ]
    await store.saveItems(c.id, items)
    await store.updateGroup(c.id, (g) => ({
      ...g,
      sessions: { ui: 'sU2', wk: 'sW1', ...(members.includes('ps') ? { ps: 'sP' } : {}) },
      seen: { ui: 'u2', wk: 'a1', ...(members.includes('ps') ? { ps: 'a2' } : {}) }
    }))
    return c
  }

  it("a member's last turn item carries end with agent and seen", async () => {
    const c = await group(['ui', 'wk'])
    scripts.ui = [{ events: turnOf('s-ui', 'ui reply', 'e1') }]
    modAnswers = [par('ui'), none()]
    await svc.send(c.id, 'hi')
    await idle(c.id)
    const items = await store.loadItems(c.id)
    expect(items[1]).toMatchObject({ type: 'assistant', agent: 'ui', end: { session: 's-ui', at: 'e1', agent: 'ui', seen: items[0].id } })
    expect(items.filter((i) => i.end)).toHaveLength(1)
  })

  it('a pass leaves no items and so stamps nothing', async () => {
    const c = await group(['ui', 'wk'])
    scripts.ui = [{ events: turnOf('s-ui', 'ui reply', 'e1') }]
    scripts.wk = [{ events: turnOf('s-wk', PASS_MARKER, 'f1') }]
    modAnswers = [none(), par('wk')]
    await svc.send(c.id, '@ui hi')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'wk'])
    expect((await store.loadItems(c.id)).filter((i) => i.end).map((i) => i.end?.agent)).toEqual(['ui'])
  })

  it('rerun rewinds every member: sessions, seen and next from before the message', async () => {
    const c = await history()
    modAnswers = ['hang']
    await svc.rerun(c.id, 'u2', 'second, better')
    const g = (await metaOf(c.id)).group
    expect(g.sessions).toEqual({ ui: 'sU1', wk: 'sW1', ps: null })
    expect(g.seen).toEqual({ ui: 'u1', wk: 'a1', ps: null })
    expect(g.next).toEqual({ ui: { at: 'e1' }, wk: { at: 'f1' } })
    chats.stop(c.id)
    await idle(c.id)
  })

  it('rerun posts the new version to the moderator and members, and they never see the hidden version', async () => {
    const c = await history()
    modAnswers = [par('ui'), none()]
    await svc.rerun(c.id, 'u2', 'second, better')
    await idle(c.id)
    const input = modInputs[0]
    expect(input.messages.map((m) => m.text)).toContain('second, better')
    expect(JSON.stringify(input.messages)).not.toContain('OLD ui answer')
    expect(JSON.stringify(input.messages)).not.toContain('"second"')
    expect(calls).toHaveLength(1)
    expect(calls[0].stdin).toContain('second, better')
    expect(calls[0].stdin).not.toContain('OLD ui answer')
    // ui is rewound to just after u1, so it gets everything it had not seen by then, wk's reply included.
    expect(calls[0].stdin).toContain('wk one')
    expect(calls[0].args.slice(calls[0].args.indexOf('--resume'), calls[0].args.indexOf('--resume') + 5)).toEqual([
      '--resume',
      'sU1',
      '--resume-session-at',
      'e1',
      '--fork-session'
    ])
    const items = await store.loadItems(c.id)
    expect(items.map((i) => i.id)).not.toContain('a3')
    expect(items.find((i) => i.type === 'user' && i.text === 'second, better')).toMatchObject({ versions: { root: 'u2', count: 2 } })
    expect((await store.loadVersions(c.id)).u2.list[0]?.tail.map((i) => i.id)).toEqual(['a3'])
  })

  it("a member's cut declares the turn it discards, and a member losing nothing declares nothing", async () => {
    const c = await group(['ui', 'wk'])
    // ui keeps one session across both turns, as a resumed session does, so its stamp names an entry in the session being cut.
    await store.saveItems(c.id, [
      { type: 'user', id: 'u1', text: 'first', ts: 1 },
      { type: 'assistant', id: 'a1', text: 'ui one', ts: 2, agent: 'ui', end: end('ui', 'sU', 'e1', 'u1') },
      { type: 'assistant', id: 'a2', text: 'wk one', ts: 3, agent: 'wk', end: end('wk', 'sW', 'f1', 'a1') },
      { type: 'user', id: 'u2', text: 'second', ts: 4 },
      {
        type: 'assistant',
        id: 'a3',
        text: 'OLD ui answer',
        ts: 5,
        agent: 'ui',
        end: end('ui', 'sU', 'e2', 'u2'),
        sent: { session: 'sU', at: 'p-u2' }
      }
    ])
    await store.updateGroup(c.id, (g) => ({ ...g, sessions: { ui: 'sU', wk: 'sW' }, seen: { ui: 'u2', wk: 'a1' } }))
    modAnswers = [par('ui', 'wk'), none()]
    await svc.rerun(c.id, 'u2', 'second, better')
    await idle(c.id)
    const argsOf = (agent: string) => calls.find((call) => call.args[call.args.indexOf('--agent') + 1] === agent)!.args
    // ui loses exactly one turn, the one stamped p-u2.
    expect(argsOf('ui').slice(argsOf('ui').indexOf('--resume'), argsOf('ui').indexOf('--resume') + 7)).toEqual([
      '--resume',
      'sU',
      '--resume-session-at',
      'e1',
      '--fork-session',
      '--resume-drops-turn',
      'p-u2'
    ])
    // wk never spoke after its own last end, so its cut discards nothing of its session and declares nothing.
    expect(argsOf('wk')).toContain('--fork-session')
    expect(argsOf('wk')).not.toContain('--resume-drops-turn')
  })

  it('rerun with no text is a Resend of the same text', async () => {
    const c = await history()
    modAnswers = [par('ui'), none()]
    await svc.rerun(c.id, 'u2', null)
    await idle(c.id)
    expect(calls[0].stdin).toContain('second')
    expect(calls[0].stdin).not.toContain('OLD ui answer')
  })

  it('rerun adds no notice when the replaced version changed files', async () => {
    const edit: ChatItem = {
      type: 'tool',
      id: 't1',
      name: 'Edit',
      input: { file_path: '/w/a.ts' },
      result: 'ok',
      isError: false,
      blocked: false,
      ts: 5,
      agent: 'ui'
    }
    const c = await history([edit])
    modAnswers = [par('ui'), none()]
    await svc.rerun(c.id, 'u2', 'again')
    await idle(c.id)
    const items = await store.loadItems(c.id)
    expect(items.some((i) => i.type === 'notice')).toBe(false)
  })

  it('rerun throws "Chat is busy" while the room runs and an unknown id leaves the chat as it was', async () => {
    const c = await history()
    modAnswers = ['hang']
    await svc.send(c.id, 'working')
    await expect(svc.rerun(c.id, 'u2', 'x')).rejects.toThrow('Chat is busy')
    chats.stop(c.id)
    await idle(c.id)
    await expect(svc.rerun(c.id, 'nope', 'x')).rejects.toThrow('Message not found')
    await expect(svc.rerun(c.id, 'u2', '  ')).rejects.toThrow('Message is empty')
    expect((await store.loadItems(c.id)).some((i) => i.id === 'a3')).toBe(true)
    expect(await store.loadVersions(c.id)).toEqual({})
  })

  it('a rerun whose group update fails puts the old version back, with sessions and seen untouched', async () => {
    const c = await history()
    const before = await store.loadItems(c.id)
    const groupBefore = (await metaOf(c.id)).group
    vi.spyOn(store, 'updateGroup').mockRejectedValueOnce(new Error('disk full'))
    pushes.length = 0
    await expect(svc.rerun(c.id, 'u2', 'second, better')).rejects.toThrow('disk full')
    expect(await store.loadItems(c.id)).toEqual(before)
    const g = (await metaOf(c.id)).group
    expect(g.sessions).toEqual(groupBefore.sessions)
    expect(g.seen).toEqual(groupBefore.seen)
    expect(g.next).toEqual(groupBefore.next)
    expect(pushes.filter((p) => p.kind === 'items').pop()).toMatchObject({ items: before })
    expect(chats.isRunning(c.id)).toBe(false)
  })

  it('an edit after a failed first edit in a room stores two versions and shows 2 / 2', async () => {
    const c = await history()
    vi.spyOn(store, 'updateGroup').mockRejectedValueOnce(new Error('disk full'))
    await expect(svc.rerun(c.id, 'u2', 'second, better')).rejects.toThrow('disk full')
    modAnswers = ['hang']
    await svc.rerun(c.id, 'u2', 'second, again')
    const shown = (await store.loadItems(c.id)).find((i) => i.type === 'user' && i.text === 'second, again')
    expect(shown).toMatchObject({ versions: { root: 'u2', index: 1, count: 2 } })
    const list = (await store.loadVersions(c.id)).u2.list
    expect(list).toHaveLength(2)
    expect(list.flatMap((v) => (v ? [v.user.text] : []))).toEqual(['second'])
    chats.stop(c.id)
    await idle(c.id)
  })

  it('a member with no end stamp but earlier replies is reseeded', async () => {
    const c = await group(['ui', 'wk'])
    await store.saveItems(c.id, [
      { type: 'user', id: 'u1', text: 'first', ts: 1 },
      { type: 'assistant', id: 'a1', text: 'old ui reply', ts: 2, agent: 'ui' },
      { type: 'user', id: 'u2', text: 'second', ts: 3 }
    ])
    await store.updateGroup(c.id, (g) => ({ ...g, sessions: { ui: 'sOld' }, seen: { ui: 'a1' } }))
    modAnswers = [par('ui'), none()]
    await svc.rerun(c.id, 'u2', 'second again')
    await idle(c.id)
    expect(calls).toHaveLength(1)
    expect(calls[0].args).not.toContain('--resume')
    expect(calls[0].stdin).toContain('old ui reply')
    expect(calls[0].stdin).toContain('second again')
    expect((await store.loadItems(c.id)).some((i) => i.type === 'notice' && i.kind === 'expired')).toBe(true)
  })

  it('a member added after the message starts fresh', async () => {
    const c = await history([], ['ui', 'wk'])
    await svc.setMembers(c.id, ['ui', 'wk', 'ps'])
    modAnswers = ['hang']
    await svc.rerun(c.id, 'u2', 'second, better')
    chats.stop(c.id)
    await idle(c.id)
    const g = (await metaOf(c.id)).group
    expect(g.sessions.ps).toBeNull()
    expect(g.seen.ps).toBeNull()
    expect(g.next?.ps).toBeUndefined()
    modAnswers = [par('ps'), none()]
    await svc.send(c.id, '@ps join in')
    await idle(c.id)
    expect(calls[calls.length - 1].args).not.toContain('--resume')
  })

  it("next[m] is cleared after m's first saved session", async () => {
    const c = await history()
    scripts.ui = [{ events: turnOf('s-new', 'fresh ui', 'e9') }]
    modAnswers = [par('ui'), none()]
    await svc.rerun(c.id, 'u2', 'second, better')
    await idle(c.id)
    const g = (await metaOf(c.id)).group
    expect(g.sessions.ui).toBe('s-new')
    expect(g.next?.ui).toBeUndefined()
    expect(g.next).toEqual({ wk: { at: 'f1' } })
    // The reply is stamped with where the new session ended and what ui has seen.
    const items = await store.loadItems(c.id)
    expect(items.find((i) => i.type === 'assistant' && i.text === 'fresh ui')).toMatchObject({
      end: { agent: 'ui', session: 's-new', at: 'e9' }
    })
  })
  it("the hidden version's last speaker does not steer routing", async () => {
    // Nobody is mentioned and the moderator picks nobody: the fallback is the visible thread's last speaker (wk, a2), not ui (hidden a3).
    const c = await history()
    modAnswers = [none(), none()]
    await svc.rerun(c.id, 'u2', 'second, better')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['wk'])
  })

  it('rerun works on the items and versions as they are once the chat is claimed', async () => {
    const c = await history()
    modAnswers = [none(), none(), none(), none()]
    await svc.rerun(c.id, 'u2', 'v2')
    await idle(c.id)
    const v2 = (await store.loadItems(c.id)).find((i) => i.type === 'user' && i.text === 'v2')!
    // A slow agents() leaves a window before the claim, in which a switch back to version 1 runs.
    let gate!: () => void
    const held = new Promise<void>((resolve) => {
      gate = resolve
    })
    let entered!: () => void
    const inWindow = new Promise<void>((resolve) => {
      entered = resolve
    })
    const slow = new GroupService({
      store,
      chats,
      files,
      moderate: async () => none(),
      push: (p) => pushes.push(p),
      now: () => 1000 + n,
      newId: () => `x${++n}`,
      disallowedToolsFor: (a) => deny(a),
      agents: async () => {
        entered()
        await held
        return agentList
      }
    })
    const rerun = slow.rerun(c.id, 'u2', 'v3').catch((e) => e)
    await inWindow
    await chats.switchVersion(c.id, v2.id, 0)
    gate()
    expect(await rerun).toBeUndefined()
    await idle(c.id)
    const items = await store.loadItems(c.id)
    const texts = [...items, ...Object.values(await store.loadVersions(c.id)).flatMap((v) => v.list.flatMap((s) => (s ? [s.user] : [])))]
      .filter((i) => i.type === 'user')
      .map((i) => (i as { text: string }).text)
      .sort()
    // Every version survives: the original, v2 (stored by the switch) and v3 (shown).
    expect(texts).toEqual(['first', 'second', 'v2', 'v3'].sort())
    expect(items.find((i) => i.type === 'user' && i.text === 'v3')).toMatchObject({ versions: { count: 3 } })
  })
})

describe('GroupService context meter and compact', () => {
  const result = (extra: object = {}): RunEvent => ({ ...okResult, windows: { m: 200_000 }, ...extra }) as RunEvent
  const used = (agent: string, tokens: number): RunEvent[] => [
    { kind: 'init', sessionId: `s-${agent}` },
    { kind: 'assistantText', text: `${agent} done` },
    { kind: 'context', model: 'm', tokens },
    result()
  ]
  const compacted = (agent: string): RunEvent[] => [
    { kind: 'compacting', on: true },
    { kind: 'compacting', on: false },
    { kind: 'init', sessionId: `s-${agent}` },
    { kind: 'compacted', pre: 150_000, post: 8_000 },
    result({ numTurns: 0 })
  ]
  // ui and wk both answer once, so each has a session and a meter.
  const ranRoom = async () => {
    const c = await group(['ui', 'wk'])
    scripts = { ui: [{ events: used('ui', 30_000) }], wk: [{ events: used('wk', 90_000) }] }
    modAnswers = [par('ui', 'wk'), none(), none()]
    await svc.send(c.id, 'hi')
    await idle(c.id)
    return c
  }

  it('each member turn saves its own meter', async () => {
    const c = await ranRoom()
    expect((await metaOf(c.id)).group.context).toEqual({
      ui: { used: 30_000, window: 200_000, at: expect.any(Number) },
      wk: { used: 90_000, window: 200_000, at: expect.any(Number) }
    })
  })

  it("a member's compaction shows on its working entry", async () => {
    const c = await group(['ui', 'wk'])
    scripts = { ui: [{ hang: true, events: [] }] }
    modAnswers = [par('ui'), none()]
    await svc.send(c.id, 'hi')
    await until(() => live.length === 1, 'ui to start')
    live[0].emit({ kind: 'compacting', on: true })
    await until(() => pushes.some((p) => p.kind === 'meta' && p.meta.group?.active.some((t) => t.compacting)), 'the compacting push')
    expect((await metaOf(c.id)).group.active).toEqual([expect.objectContaining({ agent: 'ui', compacting: true })])
    live[0].emit({ kind: 'compacting', on: false })
    await until(
      () => pushes.at(-1)?.kind === 'meta' && !(pushes.at(-1) as { meta: ChatMeta }).meta.group?.active.some((t) => t.compacting),
      'the push after'
    )
    live[0].finish()
    await idle(c.id)
  })

  it("compact runs /compact on one member's session and adds no items", async () => {
    const c = await ranRoom()
    const before = await store.loadItems(c.id)
    scripts.wk = [{ events: compacted('wk') }]
    await svc.compact(c.id, 'wk', 'keep the plan')
    const run = calls.at(-1)!
    expect(agentOf(run)).toBe('wk')
    expect(run.stdin).toBe('/compact keep the plan')
    expect(argAfter(run.args, '--resume')).toBe('s-wk')
    expect(await store.loadItems(c.id)).toEqual(before)
    const meta = await metaOf(c.id)
    expect(meta).toMatchObject({ inFlight: false })
    expect(meta.group.active).toEqual([])
    expect(meta.group.context).toEqual({
      ui: { used: 30_000, window: 200_000, at: expect.any(Number) },
      wk: { used: null, window: 200_000, compacted: { pre: 150_000, post: 8_000 }, at: expect.any(Number) }
    })
    expect(chats.isRunning(c.id)).toBe(false)
  })

  it('compact never fires the room turn hook', async () => {
    const c = await ranRoom()
    roomEnds.length = 0 // ui and wk's own turns ended before
    scripts.wk = [{ events: compacted('wk') }]
    await svc.compact(c.id, 'wk', 'keep the plan')
    expect(roomEnds).toEqual([])
  })

  it('compact shows the member working and compacting while it runs', async () => {
    const c = await ranRoom()
    scripts.wk = [{ hang: true, events: [] }]
    const p = svc.compact(c.id, 'wk', '')
    await until(() => chats.isRunning(c.id) && live.length === 3, 'the compact run')
    await until(() => pushes.some((x) => x.kind === 'meta' && x.meta.inFlight && x.meta.group?.active.length === 1), 'the working push')
    expect(await metaOf(c.id)).toMatchObject({
      inFlight: true,
      group: { active: [expect.objectContaining({ agent: 'wk', compacting: true })] }
    })
    chats.stop(c.id)
    await p
    expect(await metaOf(c.id)).toMatchObject({ inFlight: false, group: { active: [] } })
  })

  it('with Codex rooms off, compact on a member whose agent moved to Codex is refused with the room sentence before anything runs', async () => {
    const c = await ranRoom()
    svc = new GroupService({
      store,
      chats,
      files,
      agents: async () => agentList,
      moderate: async () => none(),
      push: (p) => pushes.push(p),
      now: () => 1000 + n,
      newId: () => `x${++n}`,
      disallowedToolsFor: () => [],
      engineOf: async (agent) => (agent === 'wk' ? 'codex' : 'claude'),
      caps: noCodexRooms
    })
    const before = calls.length,
      metas = pushes.length
    await expect(svc.compact(c.id, 'wk', 'keep the plan')).rejects.toThrow(CODEX_REFUSALS.room('wk'))
    expect(calls.length).toBe(before)
    expect(pushes.length).toBe(metas)
    expect(chats.isRunning(c.id)).toBe(false)
    // The Claude member still compacts.
    scripts.ui = [{ events: compacted('ui') }]
    await svc.compact(c.id, 'ui', '')
    expect(agentOf(calls.at(-1)!)).toBe('ui')
  })

  it('refuseCodex: with Codex rooms off, a member whose agent is now on Codex is refused with the room sentence; a Claude one, or no engine lookup, passes', async () => {
    const make = (engineOf?: (agent: string) => Promise<Engine>, caps?: (e: Engine) => EngineCaps) =>
      new GroupService({
        store,
        chats,
        files,
        agents: async () => agentList,
        moderate: async () => none(),
        push: (p) => pushes.push(p),
        now: () => 1000 + n,
        newId: () => `x${++n}`,
        disallowedToolsFor: () => [],
        ...(engineOf ? { engineOf } : {}),
        ...(caps ? { caps } : {})
      })
    const wkOnCodex = async (agent: string): Promise<Engine> => (agent === 'wk' ? 'codex' : 'claude')
    svc = make(wkOnCodex, noCodexRooms)
    await expect(svc.refuseCodex('wk')).rejects.toThrow(CODEX_REFUSALS.room('wk'))
    await expect(svc.refuseCodex('ui')).resolves.toBeUndefined()
    await expect(make(undefined, noCodexRooms).refuseCodex('wk')).resolves.toBeUndefined()
    // With rooms on (the default), a Codex member is refused nothing.
    await expect(make(wkOnCodex).refuseCodex('wk')).resolves.toBeUndefined()
  })

  it('compact refuses an unknown member, a member with no session and a busy room', async () => {
    const c = await ranRoom()
    await expect(svc.compact(c.id, 'ps', '')).rejects.toThrow('Not a member: ps')
    const fresh = await group(['ui', 'wk'])
    await expect(svc.compact(fresh.id, 'ui', '')).rejects.toThrow(NOTHING_TO_COMPACT)
    scripts.ui = [{ hang: true, events: [] }]
    modAnswers = [par('ui'), none()]
    await svc.send(c.id, 'again')
    await until(() => live.length === 3, 'ui to start')
    await expect(svc.compact(c.id, 'wk', '')).rejects.toThrow('Chat is already running')
    live[2].finish()
    await idle(c.id)
  })

  it('an edit clears every member meter, and a member who leaves takes its meter along', async () => {
    const c = await ranRoom()
    await svc.setMembers(c.id, ['ui', 'wk', 'ps'])
    await svc.setMembers(c.id, ['wk', 'ps'])
    expect((await metaOf(c.id)).group.context).toEqual({ wk: { used: 90_000, window: 200_000, at: expect.any(Number) } })
    const user = (await store.loadItems(c.id)).find((i) => i.type === 'user')!
    modAnswers = [none()]
    await svc.rerun(c.id, user.id, 'hi again')
    await idle(c.id)
    expect((await metaOf(c.id)).group.context).toBeUndefined()
  })
})

describe('GroupService usage hooks', () => {
  it("a room member's cost is signed with the member", async () => {
    const c = await group(['ui', 'wk'])
    const costs: { agent: string; chatId: string }[] = []
    chatDeps.onRunCost = (e) => costs.push(e)
    const cost = { totalUsd: 1, models: {} }
    scripts.ui = [
      {
        events: [
          { kind: 'init', sessionId: 's-ui' },
          { kind: 'assistantText', text: 'hi' },
          { ...okResult, uuid: 'r-ui', cost } as RunEvent
        ]
      }
    ]
    modAnswers = [par('ui'), none()]
    await svc.send(c.id, 'hi')
    await idle(c.id)
    expect(costs).toEqual([expect.objectContaining({ agent: 'ui', chatId: c.id })])
  })

  it('groupService passes the room id to moderate', async () => {
    const c = await group(['ui', 'wk'])
    modAnswers = [par('ui'), none()]
    await svc.send(c.id, 'hi')
    await idle(c.id)
    expect(modChatIds.length).toBeGreaterThan(0)
    expect(new Set(modChatIds)).toEqual(new Set([c.id]))
  })
})

describe('GroupService commands', () => {
  const cmd = { agent: 'wk', name: 'check', prompt: 'Use check on L' }
  const stdinOf = (agent: string) => calls.find((o) => agentOf(o) === agent)!.stdin

  it("the command's owner reads the prompt, others read the short form", async () => {
    const c = await group()
    modAnswers = [par('wk', 'ps')]
    modFallback = () => none()
    await svc.send(c.id, '/check L', [], undefined, undefined, cmd)
    await idle(c.id)
    expect(calls.map(agentOf).sort()).toEqual(['ps', 'wk'])
    expect(stdinOf('wk')).toContain('Use check on L')
    expect(stdinOf('wk')).not.toContain('/check L')
    expect(stdinOf('ps')).toContain('/check L')
    expect(stdinOf('ps')).not.toContain('Use check on L')
    expect((await store.loadItems(c.id))[0]).toMatchObject({ type: 'user', text: '/check L', command: cmd })
  })

  it('the moderator reads the short form and sees the owner as mentioned', async () => {
    const c = await group()
    modAnswers = [par('wk'), none()]
    await svc.send(c.id, '/check L', [], undefined, undefined, cmd)
    await idle(c.id)
    expect(modInputs[0].messages).toEqual([{ from: null, text: '/check L' }])
    expect(JSON.stringify(modInputs)).not.toContain('Use check on L')
    expect(modInputs[0].mentioned).toEqual(['wk'])
    expect(stdinOf('wk').endsWith('The user mentioned you\nGive a real reply.')).toBe(true)
  })

  it('with no moderator answer the owner still runs', async () => {
    const c = await group()
    modAnswers = [null, none()]
    await svc.send(c.id, '/check L', [], undefined, undefined, cmd)
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['wk'])
    expect(calls[0].stdin).toContain('Use check on L')
  })

  it('@mentions in a command message still count', async () => {
    const c = await group()
    modAnswers = [par('wk', 'ps'), none(), none()]
    await svc.send(c.id, '/check L @ps', [], undefined, undefined, cmd)
    await idle(c.id)
    expect(modInputs[0].mentioned).toEqual(['wk', 'ps'])
  })

  it('the owner named by @mention too is mentioned once', async () => {
    const c = await group()
    modAnswers = [par('wk'), none()]
    await svc.send(c.id, '/check L @wk', [], undefined, undefined, cmd)
    await idle(c.id)
    expect(modInputs[0].mentioned).toEqual(['wk'])
  })

  it("rerun keeps routing to the new command's owner", async () => {
    const c = await group()
    modAnswers = [par('wk'), none()]
    await svc.send(c.id, '/check L', [], undefined, undefined, cmd)
    await idle(c.id)
    const user = (await store.loadItems(c.id)).find((i) => i.type === 'user')!
    calls = []
    modAnswers = [none(), none()]
    await svc.rerun(c.id, user.id, '/check M', { ...cmd, prompt: 'Use check on M' })
    await idle(c.id)
    expect(modInputs[2].mentioned).toEqual(['wk'])
    expect(calls.map(agentOf)).toEqual(['wk'])
    expect(calls[0].stdin).toContain('Use check on M')
    expect(calls[0].stdin).not.toContain('Use check on L')
    const items = await store.loadItems(c.id)
    expect(items.find((i) => i.type === 'user')).toMatchObject({ text: '/check M', command: { ...cmd, prompt: 'Use check on M' } })
  })

  it('rerun without a command drops the old one', async () => {
    const c = await group()
    modAnswers = [par('wk'), none()]
    await svc.send(c.id, '/check L', [], undefined, undefined, cmd)
    await idle(c.id)
    const user = (await store.loadItems(c.id)).find((i) => i.type === 'user')!
    modAnswers = [none()]
    await svc.rerun(c.id, user.id, 'plain words')
    await idle(c.id)
    expect(modInputs[2].mentioned).toEqual([])
    const shown = (await store.loadItems(c.id)).find((i) => i.type === 'user')!
    expect(shown).toMatchObject({ text: 'plain words' })
    expect('command' in shown).toBe(false)
  })

  it('a reseed restores the prompt for the owner and the short form for others', async () => {
    const c = await group(['ui', 'wk'])
    const prior: ChatItem[] = [
      { type: 'user', id: 'u0', text: '/check A', ts: 1, command: { ...cmd, prompt: 'Use check on A' } },
      { type: 'assistant', id: 'b0', text: 'wk checked', ts: 2, agent: 'wk' }
    ]
    await store.saveItems(c.id, prior)
    await store.updateGroup(c.id, (g) => ({ ...g, sessions: { ui: 'old-ui', wk: 'old-wk' }, seen: { ui: 'b0', wk: 'b0' } }))
    const expired = { events: [], outcome: { exitCode: 1, stderr: 'No conversation found with session ID: old', result: null } }
    scripts.wk = [expired, { text: 'wk back' }]
    scripts.ui = [expired, { text: 'ui back' }]
    modAnswers = [seq('wk'), none(), seq('ui'), none()]
    await svc.send(c.id, '@wk more')
    await idle(c.id)
    await svc.send(c.id, '@ui more')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['wk', 'wk', 'ui', 'ui'])
    expect(calls[1].stdin).toContain('User: Use check on A')
    expect(calls[1].stdin).not.toContain('/check A')
    expect(calls[3].stdin).toContain('User: /check A')
    expect(calls[3].stdin).not.toContain('Use check on A')
  })

  describe('/todo', () => {
    const asked = () => vi.spyOn(chats, 'agentTurn')
    const todoAskedBy = (spy: ReturnType<typeof asked>, agent: string) =>
      spy.mock.calls.filter((c) => c[2].agentName === agent).map((c) => c[2].todoAsked)

    it('the member answering a /todo message gets todoAsked and the request line, one that has seen it does not', async () => {
      const c = await group(['ui', 'wk'])
      const spy = asked()
      modAnswers = [par('wk'), none(), par('wk'), none()]
      await svc.send(c.id, '/todo plan my day', [], undefined, undefined, undefined, true)
      await idle(c.id)
      expect(todoAskedBy(spy, 'wk')).toEqual([true])
      expect(stdinOf('wk')).toContain(`plan my day\n\n${TODO_REQUEST}</message>`)
      expect(stdinOf('wk')).not.toContain('/todo')
      expect(modInputs[0].messages).toEqual([{ from: null, text: '/todo plan my day' }]) // the moderator reads what was typed
      expect((await store.loadItems(c.id))[0]).toMatchObject({ type: 'user', text: '/todo plan my day', todo: true })
      await svc.send(c.id, 'thanks, and the second one?')
      await idle(c.id)
      expect(todoAskedBy(spy, 'wk')).toEqual([true, undefined])
      expect(calls[1].stdin).not.toContain(TODO_REQUEST)
    })

    it('a member that comes to the /todo message later is asked too', async () => {
      const c = await group(['ui', 'wk'])
      const spy = asked()
      modAnswers = [par('wk'), none(), par('ui'), none()]
      await svc.send(c.id, '/todo plan', [], undefined, undefined, undefined, true)
      await idle(c.id)
      await svc.send(c.id, 'and you?')
      await idle(c.id)
      expect(todoAskedBy(spy, 'ui')).toEqual([true])
    })

    it('a flagged command with the owner as reader: the prompt and the request line', async () => {
      const c = await group()
      const flagged = { ...cmd, todos: true as const }
      modAnswers = [par('wk', 'ps'), none()]
      await svc.send(c.id, '/check L', [], undefined, undefined, flagged, true)
      await idle(c.id)
      expect(stdinOf('wk')).toContain(`Use check on L\n\n${TODO_REQUEST}`)
      expect(stdinOf('ps')).toContain(`/check L\n\n${TODO_REQUEST}`)
      expect((await store.loadItems(c.id))[0]).toMatchObject({ text: '/check L', command: flagged, todo: true })
    })

    it('resend keeps the flag, an edit takes its own', async () => {
      const c = await group(['ui', 'wk'])
      modAnswers = [par('wk'), none(), par('wk'), none(), par('wk'), none(), par('wk'), none()]
      await svc.send(c.id, '/todo plan', [], undefined, undefined, undefined, true)
      await idle(c.id)
      const userOf = async () => (await store.loadItems(c.id)).find((i) => i.type === 'user')!
      await svc.rerun(c.id, (await userOf()).id, null)
      await idle(c.id)
      expect(await userOf()).toMatchObject({ text: '/todo plan', todo: true })
      expect(calls.at(-1)!.stdin).toContain(TODO_REQUEST)
      await svc.rerun(c.id, (await userOf()).id, 'plain words')
      await idle(c.id)
      const edited = await userOf()
      expect('todo' in edited).toBe(false)
      expect(calls.at(-1)!.stdin).not.toContain(TODO_REQUEST)
      await svc.rerun(c.id, edited.id, '/todo again', undefined, true)
      await idle(c.id)
      expect(await userOf()).toMatchObject({ text: '/todo again', todo: true })
    })
  })

  it('a command of a member that is gone gets no turn', async () => {
    const c = await group()
    agentList = agentList.filter((a) => a.name !== 'wk')
    modAnswers = [none()]
    await svc.send(c.id, '/check L', [], undefined, undefined, cmd)
    await idle(c.id)
    expect(modInputs[0].mentioned).toEqual([])
    expect(calls.map(agentOf)).not.toContain('wk')
  })
})

describe('GroupService to-dos', () => {
  const turnOf = (session: string, tip: string, text: string): RunEvent[] => [
    { kind: 'init', sessionId: session },
    { kind: 'entry', uuid: tip },
    { kind: 'assistantText', text },
    okResult
  ]

  it.each([['settle'], ['markSeen']])('a throwing %s never fails the member turn or halts the room', async (broken) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fail = async () => {
      throw Object.assign(new Error('EACCES: permission denied, open /data/chats/c.todos.json'), { code: 'EACCES' })
    }
    const fake = {
      note: vi.fn(async () => ({ text: null, rev: 2 })),
      touch: vi.fn(() => null),
      endTurn: vi.fn(),
      settle: vi.fn(broken === 'settle' ? fail : async () => {}),
      markSeen: vi.fn(broken === 'markSeen' ? fail : async () => {})
    }
    chatDeps.todos = fake
    const c = await group(['ui', 'wk'])
    scripts.ui = [{ events: turnOf('s-ui', 'e1', 'ui reply') }]
    modAnswers = [par('ui'), none()]
    await svc.send(c.id, 'hi')
    await idle(c.id)
    expect(fake[broken as 'settle' | 'markSeen']).toHaveBeenCalled()
    const items = await store.loadItems(c.id)
    expect(items.some((i) => i.type === 'error')).toBe(false)
    expect(items[1]).toMatchObject({ type: 'assistant', agent: 'ui', end: { session: 's-ui', at: 'e1', agent: 'ui', seen: items[0].id } })
    expect((await metaOf(c.id)).group.seen.ui).toBe(items[0].id)
    // The reply reached the moderator, so the room was not halted.
    expect(modInputs.map((i) => i.speaker)).toEqual([null, 'ui'])
    expect(roomEnds).toEqual([expect.objectContaining({ chatId: c.id, agent: 'ui', outcome: 'ok' })])
    expect(log.mock.calls.flat().join(' ')).not.toContain('/data/chats')
    log.mockRestore()
  })

  it("a member's cut run after an edit gets the open items though it saw the list", async () => {
    const c = await group(['ui', 'wk'])
    await store.saveItems(c.id, [
      { type: 'user', id: 'u1', text: 'first', ts: 1 },
      { type: 'assistant', id: 'a1', text: 'ui one', ts: 2, agent: 'ui', end: { agent: 'ui', session: 'sU1', at: 'e1', seen: 'u1' } },
      { type: 'user', id: 'u2', text: 'second', ts: 3 },
      { type: 'assistant', id: 'a2', text: 'OLD ui answer', ts: 4, agent: 'ui', end: { agent: 'ui', session: 'sU2', at: 'e2', seen: 'u2' } }
    ])
    await store.updateGroup(c.id, (g) => ({ ...g, sessions: { ui: 'sU2' }, seen: { ui: 'u2' } }))
    let tn = 0
    const todos = new TodoService({ store, now: () => 5000, newId: () => `td${++tn}`, onChanged: () => {} })
    chatDeps.todos = todos
    await todos.agentAdd(c.id, 'wk', 'earlier', 'Digest', [{ text: 'Reply to Morjan' }])
    await todos.markSeen(c.id, 'ui', (await todos.list(c.id)).rev)
    scripts.ui = [{ events: turnOf('sU3', 'g1', 'ui better') }]
    modAnswers = [par('ui'), none()]
    await svc.rerun(c.id, 'u2', 'second, better')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui'])
    expect(calls[0].args).toContain('--resume-session-at')
    expect(calls[0].stdin).toMatch(
      /second, better[^]*\n\nThe user's task board[^]*- \[td1\] Reply to Morjan \(by [a-z-]+; nobody assigned; New\)$/
    )
  })
})

describe('GroupService run messages', () => {
  it('room run item keeps its mark', async () => {
    const run = { processId: 'p_0000000001' }
    const c = await group(['ui', 'wk'])
    modAnswers = [none()]
    await svc.send(c.id, '@ui the run ended', [], undefined, undefined, undefined, undefined, undefined, undefined, run)
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui'])
    const user = (await store.loadItems(c.id)).find((i) => i.type === 'user')
    expect(user).toMatchObject({ text: '@ui the run ended', run })
    expect(user).not.toHaveProperty('workflowSent')
    // A run's text never titles the room.
    expect((await metaOf(c.id)).title).toBe('')
  })

  it("routes a run result on its first line only: the output's @mentions and @everyone are material", async () => {
    const run = { processId: 'p_0000000001' }
    const c = await group(['ui', 'wk'])
    modAnswers = [none()]
    const text = runResultText({
      command: 'git log -1',
      output: 'ping @wk @everyone, ask @ghost\n',
      cut: false,
      end: { kind: 'exit', code: 0 },
      mention: 'ui'
    })
    await svc.send(c.id, text, [], undefined, undefined, undefined, undefined, undefined, undefined, run)
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui'])
    expect(modInputs[0]).toMatchObject({ everyone: false, mentioned: ['ui'] })
    // A missing member named in the output gets no notice either.
    expect((await store.loadItems(c.id)).some((i) => i.type === 'notice')).toBe(false)
  })
})

describe('GroupService unattended rooms', () => {
  const sendAuto = (chatId: string, text: string) => svc.send(chatId, text, [], undefined, undefined, undefined, undefined, undefined, true)
  const turns = () => vi.spyOn(chats, 'agentTurn')
  const autoOf = (spy: ReturnType<typeof turns>) => spy.mock.calls.map((c) => c[2].auto)

  it('a room opened by an auto message runs every member turn auto, a hand-off included', async () => {
    const c = await group()
    const spy = turns()
    modAnswers = [seq('ui'), none(), none()]
    scripts.ui = [{ text: '@wk please add it' }]
    await sendAuto(c.id, '@ui start')
    await idle(c.id)
    expect(spy.mock.calls.map((x) => x[2].agentName)).toEqual(['ui', 'wk'])
    expect(autoOf(spy)).toEqual([true, true])
  })

  it('a user message joining the open room takes the flag off the turns that start after it', async () => {
    const c = await group()
    const spy = turns()
    modAnswers = [par('ui'), par('wk'), none(), none()]
    scripts.ui = [{ hang: true }]
    await sendAuto(c.id, '@ui go')
    await until(() => calls.length === 1, 'ui to start')
    await svc.send(c.id, '@wk and you')
    live[0].finish()
    await idle(c.id)
    expect(spy.mock.calls.map((x) => [x[2].agentName, x[2].auto])).toEqual([
      ['ui', true],
      ['wk', undefined]
    ])
    expect(spy.mock.calls[1][2]).not.toHaveProperty('auto')
  })

  it('an auto message joining a room the user opened leaves it attended', async () => {
    const c = await group()
    const spy = turns()
    modAnswers = [par('ui'), par('wk'), none(), none()]
    scripts.ui = [{ hang: true }]
    await svc.send(c.id, '@ui go')
    await until(() => calls.length === 1, 'ui to start')
    await sendAuto(c.id, '@wk tick')
    live[0].finish()
    await idle(c.id)
    expect(autoOf(spy)).toEqual([undefined, undefined])
  })

  it('a user-opened room never has it, and the next room opened by an auto message is unattended again', async () => {
    const c = await group()
    const spy = turns()
    await svc.send(c.id, '@ui hi')
    await idle(c.id)
    expect(spy.mock.calls[0][2]).not.toHaveProperty('auto')
    await sendAuto(c.id, '@ui tick')
    await idle(c.id)
    expect(spy.mock.calls[1][2].auto).toBe(true)
    await svc.send(c.id, '@ui typed')
    await idle(c.id)
    expect(spy.mock.calls[2][2]).not.toHaveProperty('auto')
  })

  it('an edit and resend of an auto message carries no auto', async () => {
    const c = await group()
    const spy = turns()
    await sendAuto(c.id, '@ui tick')
    await idle(c.id)
    const user = (await store.loadItems(c.id)).find((i) => i.type === 'user')!
    await svc.rerun(c.id, user.id, null)
    await idle(c.id)
    expect(autoOf(spy)).toEqual([true, undefined])
  })
})

describe('GroupService pause', () => {
  // What TaskQueue.pause does before it tells the room: the pausing state, the flag and the held tray.
  const pressPause = async (id: string) => {
    await store.patchInPlace(id, () => ({ pause: 'pausing' }))
    await chats.setPauseFlag(id, true)
    await store.holdTasks(id)
    return svc.requestPause(id)
  }
  // What TaskQueue.resumePaused does before it asks the room.
  const pressResume = async (id: string, messageId?: string) => {
    await store.patchInPlace(id, () => ({ pause: undefined, held: undefined }))
    await svc.resume(id, messageId)
  }
  const kinds = (items: ChatItem[]) => items.map((i) => (i.type === 'notice' ? `notice:${i.kind}` : i.type))
  const userTexts = (items: ChatItem[]) => items.flatMap((i) => (i.type === 'user' ? [i.text] : []))
  const groupsPushed = (id: string) => pushes.flatMap((p) => (p.kind === 'meta' && p.chatId === id && p.meta.group ? [p.meta.group] : []))
  const lastPush = <K extends ChatPush['kind']>(id: string, kind: K) =>
    pushes.filter((p): p is Extract<ChatPush, { kind: K }> => p.kind === kind && p.chatId === id).pop()
  const isLive = (i: ChatItem) => 'turn' in i && i.turn !== undefined
  const posted = (id: string, match: (i: ChatItem) => boolean) =>
    pushes.some((p) => p.kind === 'items' && p.chatId === id && p.items.some((i) => match(i) && !isLive(i)))
  // A moderator answer the test hands over later.
  const later = () => {
    let answer: (a: ModeratorAnswer | null) => void = () => {}
    const promise = new Promise<ModeratorAnswer | null>((resolve) => {
      answer = resolve
    })
    return { promise, answer: (a: ModeratorAnswer | null) => answer(a) }
  }
  // ui works and wk waits for it when Pause is pressed.
  const pausedWhileUiWorks = async () => {
    const c = await group()
    modAnswers = [seq('ui', 'wk')]
    scripts.ui = [{ hang: true }]
    await svc.send(c.id, '@ui @wk go')
    await until(() => calls.length === 1, 'ui to start')
    expect((await metaOf(c.id)).group.queue).toEqual([{ agent: 'wk', after: ['ui'] }])
    expect(await pressPause(c.id)).toBe(true)
    return c
  }

  it('requestPause is false when no room runs', async () => {
    const c = await group()
    expect(svc.requestPause(c.id)).toBe(false)
    await svc.send(c.id, '@ui hi')
    await idle(c.id)
    expect(svc.requestPause(c.id)).toBe(false)
    expect((await metaOf(c.id)).pause).toBeUndefined()
  })

  it('a queued member never starts, a finished reply is not routed, and the room ends paused with who worked and what waited', async () => {
    const flags = vi.spyOn(chats, 'setPauseFlag')
    const c = await pausedWhileUiWorks()
    // A message sent meanwhile waits in the tray: the pause holds it before the room lets go of the chat.
    await store.addTask(c.id, { id: 't1', text: 'later', ts: 5 })
    const atIdle: Promise<[ChatMeta | null, ChatItem[]]>[] = []
    chatDeps.onIdle = (id) => {
      atIdle.push(Promise.all([store.get(id), store.loadItems(id)]))
    }
    live[0].finish()
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui'])
    expect(modInputs).toHaveLength(1) // ui's reply never reached the moderator
    const meta = await metaOf(c.id)
    expect(meta.group.paused).toEqual({ members: ['ui'], queue: [{ agent: 'wk', after: ['ui'] }], reasons: { wk: { kind: 'user' } } })
    expect(meta.group.queue).toEqual([])
    expect(meta.group.active).toEqual([])
    expect(meta).toMatchObject({ pause: 'paused', held: true, inFlight: false, tasks: [expect.objectContaining({ id: 't1' })] })
    const items = await store.loadItems(c.id)
    expect(kinds(items)).toEqual(['user', 'assistant', 'notice:userPaused'])
    expect(items[2]).toMatchObject({ text: 'Paused. Press Resume to continue.' })
    // Paused, held and saved before the idle that would start the next task.
    expect(atIdle).toHaveLength(1)
    const [idleMeta, idleItems] = await atIdle[0]
    expect(idleMeta).toMatchObject({ pause: 'paused', held: true })
    expect(kinds(idleItems)).toEqual(['user', 'assistant', 'notice:userPaused'])
    // The tabs see the same, and the flag is gone.
    expect(kinds(lastPush(c.id, 'items')!.items)).toEqual(['user', 'assistant', 'notice:userPaused'])
    expect(lastPush(c.id, 'meta')!.meta).toMatchObject({
      pause: 'paused',
      inFlight: false,
      group: { paused: meta.group.paused, queue: [], active: [] }
    })
    expect(flags).toHaveBeenLastCalledWith(c.id, false)
    expect(roomEnds).toEqual([expect.objectContaining({ chatId: c.id, agent: 'ui', outcome: 'ok' })])
  })

  it('a Pause while the moderator routes a reply lets it finish and saves the queue it planned, with its note', async () => {
    const c = await group()
    const mod = later()
    modAnswers = [par('ui', 'wk'), mod.promise]
    scripts.wk = [{ hang: true }]
    await svc.send(c.id, '@ui @wk go')
    await until(() => modInputs.length === 2, "the moderator call for ui's reply")
    expect(modInputs[1]).toMatchObject({ speaker: 'ui', working: ['wk'] })
    expect(await pressPause(c.id)).toBe(true)
    mod.answer({ next: [pick('ps', [], 'check the tests')], drop: [], skip: [], askUser: false })
    await until(() => groupsPushed(c.id).some((g) => g.queue.some((e) => e.agent === 'ps')), 'the planned queue')
    expect(modSignals[1].aborted).toBe(false)
    live[1].finish()
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'wk'])
    expect(modInputs).toHaveLength(2) // wk's reply was not routed
    const meta = await metaOf(c.id)
    expect(meta.group.paused).toEqual({
      members: ['wk'],
      queue: [{ agent: 'ps', after: [] }],
      reasons: { ps: { kind: 'moderator', note: 'check the tests' } }
    })
    expect(meta.pause).toBe('paused')
    expect(kinds(await store.loadItems(c.id))).toEqual(['user', 'assistant', 'assistant', 'notice:userPaused'])
    // After Resume ps still gets the moderator's word for it.
    await pressResume(c.id)
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'wk', 'wk', 'ps'])
    expect(calls[3].stdin.endsWith('Note from the moderator: check the tests')).toBe(true)
  })

  it("an agent's reply still waiting to be routed when Pause is pressed is dropped", async () => {
    const c = await group()
    const mod = later()
    modAnswers = [par('ui', 'wk'), mod.promise]
    scripts.wk = [{ hang: true, events: replyEvents('wk', '@ps your turn') }]
    await svc.send(c.id, '@ui @wk go')
    await until(() => modInputs.length === 2, "the moderator call for ui's reply")
    live[1].finish()
    await until(() => posted(c.id, (i) => i.type === 'assistant' && i.agent === 'wk'), "wk's reply to be posted")
    expect(await pressPause(c.id)).toBe(true)
    mod.answer(none())
    await idle(c.id)
    expect(modInputs).toHaveLength(2)
    expect(calls.map(agentOf)).toEqual(['ui', 'wk'])
    const meta = await metaOf(c.id)
    expect(meta.group.paused).toEqual({ members: [], queue: [] })
    expect(meta.pause).toBe('paused')
  })

  it('resume addresses the paused members, then the saved queue runs and is forgotten', async () => {
    const c = await pausedWhileUiWorks()
    live[0].finish()
    await idle(c.id)
    await pressResume(c.id, 'resume-1')
    await idle(c.id)
    // Under the id TaskQueue named, so a routine run the pause stopped can follow it.
    expect((await store.loadItems(c.id)).find((i) => i.type === 'user' && i.text === '@ui Continue')?.id).toBe('resume-1')
    expect(calls.map(agentOf)).toEqual(['ui', 'ui', 'wk'])
    expect(calls[1].stdin).toContain('<message from="user">@ui Continue</message>')
    expect(calls[1].stdin.endsWith('The user mentioned you\nGive a real reply.')).toBe(true)
    // wk was the user's request before the pause, and still is: it must reply, not pass.
    expect(calls[2].stdin.endsWith('The user mentioned you\nGive a real reply.')).toBe(true)
    const items = await store.loadItems(c.id)
    expect(userTexts(items)).toEqual(['@ui @wk go', '@ui Continue'])
    expect(kinds(items)).toEqual(['user', 'assistant', 'notice:userPaused', 'user', 'assistant', 'assistant'])
    // Once the Continue was routed, the saved wk joined the queue behind ui, waiting for it as before.
    const routed = groupsPushed(c.id).find((g) => g.queue.map((e) => e.agent).join() === 'ui,wk')
    expect(routed?.queue).toEqual([
      { agent: 'ui', after: [] },
      { agent: 'wk', after: ['ui'] }
    ])
    expect(routed).not.toHaveProperty('paused')
    const meta = await metaOf(c.id)
    expect(meta.group).not.toHaveProperty('paused')
    expect(meta.group.queue).toEqual([])
    expect(meta.pause).toBeUndefined()
  })

  it('Resume of a room an auto message opened carries no auto', async () => {
    const c = await group()
    const spy = vi.spyOn(chats, 'agentTurn')
    modAnswers = [seq('ui', 'wk')]
    scripts.ui = [{ hang: true }]
    await svc.send(c.id, '@ui @wk go', [], undefined, undefined, undefined, undefined, undefined, true)
    await until(() => calls.length === 1, 'ui to start')
    expect(await pressPause(c.id)).toBe(true)
    live[0].finish()
    await idle(c.id)
    await pressResume(c.id)
    await idle(c.id)
    expect(spy.mock.calls.map((x) => [x[2].agentName, x[2].auto])).toEqual([
      ['ui', true],
      ['ui', undefined],
      ['wk', undefined]
    ])
  })

  it('a room paused before anyone started resumes with plain Continue, never queueing a member twice', async () => {
    const c = await group()
    const mod = later()
    modAnswers = [mod.promise]
    await svc.send(c.id, '@ui @wk go')
    await until(() => modInputs.length === 1, 'the moderator call')
    expect(await pressPause(c.id)).toBe(true)
    mod.answer(seq('ui', 'wk'))
    await idle(c.id)
    expect(calls).toEqual([])
    expect((await metaOf(c.id)).group.paused).toEqual({
      members: [],
      queue: [
        { agent: 'ui', after: [] },
        { agent: 'wk', after: ['ui'] }
      ],
      reasons: { ui: { kind: 'user' }, wk: { kind: 'user' } }
    })
    expect(kinds(await store.loadItems(c.id))).toEqual(['user', 'notice:userPaused'])
    // The moderator queues wk for the Continue itself: only ui is added from the saved queue.
    modAnswers = [par('wk')]
    await pressResume(c.id)
    await idle(c.id)
    expect(userTexts(await store.loadItems(c.id))).toEqual(['@ui @wk go', 'Continue'])
    expect(modInputs[1]).toMatchObject({ speaker: null, mentioned: [] })
    expect(calls.map(agentOf)).toEqual(['wk', 'ui'])
    // wk keeps the reason the Continue's plan gave it; ui gets back the one it had.
    expect(calls[0].stdin.endsWith("The user's message is for the group; please answer it.\nGive a real reply.")).toBe(true)
    expect(calls[1].stdin.endsWith('The user mentioned you\nGive a real reply.')).toBe(true)
    expect((await metaOf(c.id)).group).not.toHaveProperty('paused')
  })

  it('resume leaves out a member that left the room', async () => {
    const c = await pausedWhileUiWorks()
    live[0].finish()
    await idle(c.id)
    await store.updateGroup(c.id, (g) => ({ ...g, members: ['ui', 'ps'] })) // wk left while the room was paused
    await pressResume(c.id)
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'ui'])
    expect((await metaOf(c.id)).group).not.toHaveProperty('paused')
  })

  it('a Stop while pausing ends stopped, then paused, keeping the saved queue', async () => {
    const c = await pausedWhileUiWorks()
    chats.stop(c.id)
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui'])
    expect(kinds(await store.loadItems(c.id))).toEqual(['user', 'notice:stopped', 'notice:userPaused'])
    const meta = await metaOf(c.id)
    expect(meta.group.paused).toEqual({ members: ['ui'], queue: [{ agent: 'wk', after: ['ui'] }], reasons: { wk: { kind: 'user' } } })
    expect(meta.group.queue).toEqual([])
    expect(meta.group.active).toEqual([])
    expect(meta.pause).toBe('paused')
    expect(chats.runningCount()).toBe(0)
  })

  it('a member failing while the room pauses still ends paused, keeping the saved queue', async () => {
    const c = await group()
    modAnswers = [seq('ui', 'wk')]
    scripts.ui = [{ hang: true, events: [], outcome: { exitCode: 1, result: null } }]
    await svc.send(c.id, '@ui @wk go')
    await until(() => calls.length === 1, 'ui to start')
    expect(await pressPause(c.id)).toBe(true)
    live[0].finish()
    await idle(c.id)
    expect(kinds(await store.loadItems(c.id))).toEqual(['user', 'error', 'notice:userPaused'])
    const meta = await metaOf(c.id)
    expect(meta.group.paused).toEqual({ members: ['ui'], queue: [{ agent: 'wk', after: ['ui'] }], reasons: { wk: { kind: 'user' } } })
    expect(meta.pause).toBe('paused')
  })

  it('a message the user sends instead of Resume drops the saved queue', async () => {
    const c = await pausedWhileUiWorks()
    live[0].finish()
    await idle(c.id)
    await store.patchInPlace(c.id, () => ({ pause: undefined })) // TaskQueue lets the user's own message in
    await svc.send(c.id, '@ps over to you')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'ps'])
    expect((await metaOf(c.id)).group).not.toHaveProperty('paused')
  })

  it('an edit instead of Resume drops the saved queue', async () => {
    const c = await pausedWhileUiWorks()
    live[0].finish()
    await idle(c.id)
    await store.patchInPlace(c.id, () => ({ pause: undefined }))
    const first = (await store.loadItems(c.id))[0]
    await svc.rerun(c.id, first.id, '@ps instead')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'ps'])
    expect((await metaOf(c.id)).group).not.toHaveProperty('paused')
  })

  it('a member renamed while the room pauses is saved under its new name', async () => {
    const c = await pausedWhileUiWorks()
    agentList = agentList.map((a) => (a.name === 'ui' ? agentSummary('designer') : a))
    svc.renameAgent('ui', 'designer')
    await store.renameAgent('ui', 'designer')
    live[0].finish()
    await idle(c.id)
    expect((await metaOf(c.id)).group.paused).toEqual({
      members: ['designer'],
      queue: [{ agent: 'wk', after: ['designer'] }],
      reasons: { wk: { kind: 'user' } }
    })
  })

  it('a Pause pressed while the room opens finds no room yet, and the room pauses as it starts', async () => {
    const c = await group()
    const told: boolean[] = []
    const update = store.update.bind(store)
    store.update = async (id, patch) => {
      const out = await update(id, patch)
      if (patch.inFlight === true && told.length === 0) told.push(await pressPause(id))
      return out
    }
    modAnswers = [seq('ui', 'wk')]
    await svc.send(c.id, '@ui @wk go')
    await idle(c.id)
    expect(told).toEqual([false])
    expect(calls).toEqual([])
    const meta = await metaOf(c.id)
    expect(meta.group.paused).toEqual({
      members: [],
      queue: [
        { agent: 'ui', after: [] },
        { agent: 'wk', after: ['ui'] }
      ],
      reasons: { ui: { kind: 'user' }, wk: { kind: 'user' } }
    })
    expect(meta.pause).toBe('paused')
    expect(kinds(await store.loadItems(c.id))).toEqual(['user', 'notice:userPaused'])
  })

  it("a Pause pressed once the room has settled its end is not the room's to land: it writes nothing after it lets go", async () => {
    const c = await group()
    const land = vi.spyOn(chats, 'finishPause')
    const told: boolean[] = []
    const update = store.update.bind(store)
    store.update = async (id, patch) => {
      if (patch.inFlight === false && told.length === 0) told.push(await pressPause(id))
      return update(id, patch)
    }
    modAnswers = [seq('ui')]
    await svc.send(c.id, '@ui go')
    await idle(c.id)
    await sleep(30)
    expect(told).toEqual([false])
    // The task queue's pump lands it, under the chat's lock (below); the room has let go of the chat.
    expect(land).not.toHaveBeenCalled()
    expect((await metaOf(c.id)).pause).toBe('pausing')
    expect(kinds(await store.loadItems(c.id))).toEqual(['user', 'assistant'])
  })

  // The queue as app.ts wires it: every room end reaches its pump through onIdle. `slow` delays the queue's own reads.
  const queued = (slow = 0) => {
    const tracked: TaskQueueDeps['store'] = {
      get: async (id) => {
        if (slow > 0) await sleep(slow)
        return store.get(id)
      },
      list: () => store.list(),
      loadItems: (id) => store.loadItems(id),
      addTask: (id, task, hold) => store.addTask(id, task, hold),
      takeTask: (id) => store.takeTask(id),
      dropTask: (id, taskId) => store.dropTask(id, taskId),
      holdTasks: (id) => store.holdTasks(id),
      patchInPlace: (id, fn) => store.patchInPlace(id, fn)
    }
    const queue = new TaskQueue({
      store: tracked,
      chats,
      groups: svc,
      files,
      push: (p) => pushes.push(p),
      now: () => 1000 + n,
      newId: () => `x${++n}`
    })
    chatDeps.onIdle = (id) => {
      idled.push(id)
      queue.idle(id)
    }
    // A build with the hook: without it the queue refuses Pause.
    chatDeps.tmp = new ChatTmp(join(dir, 'claude-tmp'))
    chatDeps.pauseHook = { settings: pauseSettings({ node: '/opt/node', entry: '/opt/pauseHook.mjs', electronNode: false }) }
    return queue
  }
  // Presses Pause through the queue in the tick the room's end clears inFlight: after it has looked for a pause.
  const pauseAtSettle = (queue: TaskQueue) => {
    const told: string[] = []
    const update = store.update.bind(store)
    store.update = async (id, patch) => {
      if (patch.inFlight === false && told.length === 0) {
        told.push('pressed')
        await queue.pause(id)
        told.push('paused')
      }
      return update(id, patch)
    }
    return told
  }

  it("a Pause pressed once the room has settled its end is landed by the queue's pump once the room lets go", async () => {
    const queue = queued()
    const c = await group()
    const told = pauseAtSettle(queue)
    modAnswers = [seq('ui')]
    await queue.submit(c.id, '@ui go', [])
    await idle(c.id)
    await until(() => lastPush(c.id, 'meta')?.meta.pause === 'paused', 'the late pause to land')
    expect(told).toEqual(['pressed', 'paused'])
    expect(calls.map(agentOf)).toEqual(['ui'])
    const meta = await metaOf(c.id)
    expect(meta).toMatchObject({ pause: 'paused', inFlight: false })
    expect(kinds(await store.loadItems(c.id))).toEqual(['user', 'assistant', 'notice:userPaused'])
  })

  it('a Pause on a settled room, then an Edit right away: the late landing never saves over the edit', async () => {
    // The queue looks slowly, so a landing outside its lock would get to the items first.
    const queue = queued(30)
    const c = await group()
    const told = pauseAtSettle(queue)
    // The landing's save is slow too: an edit that does not wait for it would save in between.
    const save = store.saveItems.bind(store)
    store.saveItems = async (id, items) => {
      const last = items.at(-1)
      if (last?.type === 'notice' && last.kind === 'userPaused') await sleep(80)
      return save(id, items)
    }
    modAnswers = [seq('ui'), seq('ui')]
    scripts.ui = [{ text: 'first' }, { text: 'second' }]
    await queue.submit(c.id, '@ui go', [])
    await idle(c.id)
    const userId = (await store.loadItems(c.id))[0].id
    await queue.rerun(c.id, userId, '@ui go, edited')
    await idle(c.id)
    await sleep(150) // a stale save still on its way would land by now
    expect(told).toEqual(['pressed', 'paused'])
    const items = await store.loadItems(c.id)
    expect(items[0]).toMatchObject({ type: 'user', text: '@ui go, edited', versions: { index: 1, count: 2 } })
    expect(kinds(items)).toEqual(['user', 'assistant'])
    expect(assistants(items).map((a) => a.text)).toEqual(['second'])
    expect((await metaOf(c.id)).pause).toBeUndefined()
    // The pause landed first, under the queue's lock, so its notice went with the old version.
    expect(kinds((await store.loadVersions(c.id))[userId].list[0]!.tail)).toEqual(['assistant', 'notice:userPaused'])
  })

  // ui works; wk's reply asked for ps, whom the moderator queued after ui.
  const pausedWithAgentRequest = async () => {
    const c = await group()
    modAnswers = [par('ui', 'wk'), { next: [pick('ps', ['ui'])], drop: [], skip: [], askUser: false }]
    scripts.ui = [{ hang: true }]
    scripts.wk = [{ text: '@ps your turn' }]
    await svc.send(c.id, '@ui @wk go')
    await until(() => groupsPushed(c.id).some((g) => g.queue.some((e) => e.agent === 'ps')), 'ps to be queued')
    expect(await pressPause(c.id)).toBe(true)
    return c
  }

  it('a member another member asked for keeps that reason after Resume, so it may still pass', async () => {
    const c = await pausedWithAgentRequest()
    live[0].finish()
    await idle(c.id)
    expect((await metaOf(c.id)).group.paused).toEqual({
      members: ['ui'],
      queue: [{ agent: 'ps', after: ['ui'] }],
      reasons: { ps: { kind: 'agent', by: 'wk' } }
    })
    await pressResume(c.id)
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui', 'wk', 'ui', 'ps'])
    expect(calls[3].stdin.endsWith(`You were mentioned by @wk\nIf it asks nothing of you, reply with exactly ${PASS_MARKER}.`)).toBe(true)
  })

  it('members renamed while the room pauses keep their saved reasons, under the new names', async () => {
    const c = await pausedWithAgentRequest()
    for (const [from, to] of [
      ['wk', 'writer'],
      ['ps', 'tester']
    ]) {
      agentList = agentList.map((a) => (a.name === from ? agentSummary(to) : a))
      svc.renameAgent(from, to)
      await store.renameAgent(from, to)
    }
    live[0].finish()
    await idle(c.id)
    expect((await metaOf(c.id)).group.paused).toEqual({
      members: ['ui'],
      queue: [{ agent: 'tester', after: ['ui'] }],
      reasons: { tester: { kind: 'agent', by: 'writer' } }
    })
  })

  it('a Resume sent twice never queues a member that is already working', async () => {
    const c = await group()
    const mod = later()
    modAnswers = [mod.promise]
    await svc.send(c.id, 'go')
    await until(() => modInputs.length === 1, 'the moderator call')
    expect(await pressPause(c.id)).toBe(true)
    mod.answer(par('wk'))
    await idle(c.id)
    expect((await metaOf(c.id)).group.paused).toEqual({
      members: [],
      queue: [{ agent: 'wk', after: [] }],
      reasons: { wk: { kind: 'answer' } }
    })
    scripts.wk = [{ hang: true }]
    const first = later()
    modAnswers = [first.promise]
    await store.patchInPlace(c.id, () => ({ pause: undefined, held: undefined }))
    // Both read the saved queue: the first Continue's routing is held until the second is posted.
    await Promise.all([svc.resume(c.id), svc.resume(c.id)])
    first.answer(none())
    // The second Continue's plan (ui again, by the fallback) is saved while wk still works.
    await until(
      () => groupsPushed(c.id).some((g) => g.queue.some((e) => e.agent === 'ui') && g.active.some((t) => t.agent === 'wk')),
      'the second Continue to be routed while wk works'
    )
    live[calls.findIndex((o) => agentOf(o) === 'wk')].finish()
    await idle(c.id)
    expect(userTexts(await store.loadItems(c.id))).toEqual(['go', 'Continue', 'Continue'])
    expect(calls.filter((o) => agentOf(o) === 'wk')).toHaveLength(1)
    expect((await metaOf(c.id)).group).not.toHaveProperty('paused')
  })

  // Holds the first store read made while the chat runs (the loop's own first read), until the returned release.
  const holdLoopStart = (id: string) => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let held = false
    const get = store.get.bind(store)
    store.get = async (chatId) => {
      if (!held && chatId === id && chats.isRunning(id)) {
        held = true
        await gate
      }
      return get(chatId)
    }
    return { release: () => release(), held: () => held }
  }

  const pausedAndIdle = async () => {
    const c = await pausedWhileUiWorks()
    live[0].finish()
    await idle(c.id)
    await store.patchInPlace(c.id, () => ({ pause: undefined, held: undefined }))
    return c
  }

  it("a Stop before Resume's message is routed drops the saved queue", async () => {
    const c = await pausedAndIdle()
    const loopStart = holdLoopStart(c.id)
    await svc.resume(c.id)
    await until(loopStart.held, 'the room to start')
    chats.stop(c.id)
    loopStart.release()
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui'])
    expect(kinds(await store.loadItems(c.id)).slice(-2)).toEqual(['user', 'notice:stopped'])
    const meta = await metaOf(c.id)
    expect(meta.group).not.toHaveProperty('paused')
    expect(meta.pause).toBeUndefined()
  })

  it("a Pause and a Stop before Resume's message is routed save its queue again", async () => {
    const c = await pausedAndIdle()
    const loopStart = holdLoopStart(c.id)
    await svc.resume(c.id)
    await until(loopStart.held, 'the room to start')
    expect(await pressPause(c.id)).toBe(true)
    chats.stop(c.id)
    loopStart.release()
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui'])
    expect(kinds(await store.loadItems(c.id)).slice(-3)).toEqual(['user', 'notice:stopped', 'notice:userPaused'])
    const meta = await metaOf(c.id)
    expect(meta.group.paused).toEqual({ members: ['ui'], queue: [{ agent: 'wk', after: ['ui'] }], reasons: { wk: { kind: 'user' } } })
    expect(meta.pause).toBe('paused')
  })

  it("a failure while Resume's message is routed drops the saved queue", async () => {
    const c = await pausedAndIdle()
    const updateGroup = store.updateGroup.bind(store)
    let failed = false
    store.updateGroup = async (id, fn) => {
      const cur = (await store.get(id))?.group
      if (!failed && cur?.paused && !('paused' in fn(cur))) {
        failed = true
        throw new Error('disk full')
      }
      return updateGroup(id, fn)
    }
    await svc.resume(c.id)
    await idle(c.id)
    expect(failed).toBe(true)
    expect(calls.map(agentOf)).toEqual(['ui'])
    const items = await store.loadItems(c.id)
    expect(items[items.length - 1]).toMatchObject({ type: 'error', text: 'disk full' })
    expect((await metaOf(c.id)).group).not.toHaveProperty('paused')
  })
})

describe('GroupService lost subagents', () => {
  const agentCall = (id: string, description: string): RunEvent => ({ kind: 'toolUse', id, name: 'Agent', input: { description } })
  const liveOf = (agent: string) => live[calls.findIndex((c) => agentOf(c) === agent)]
  beforeEach(() => {
    chatDeps.dispatch = new DispatchService({ store, onChanged: () => {}, now: () => 5000, privateTool: () => null, delayMs: 5 })
  })

  it("a member's lost subagents reach only that member's next turn", async () => {
    const c = await group(['ui', 'wk'])
    scripts.ui = [{ hang: true }]
    scripts.wk = [{ hang: true }]
    modAnswers = [par('ui', 'wk')]
    await svc.send(c.id, '@ui @wk go')
    await until(() => calls.length === 2, 'both members to start')
    liveOf('ui').emit({ kind: 'init', sessionId: 's-ui' })
    liveOf('ui').emit(agentCall('u1', 'scan the logs'))
    liveOf('wk').emit({ kind: 'init', sessionId: 's-wk' })
    liveOf('wk').emit(agentCall('w1', 'review the diff'))
    liveOf('wk').emit({
      kind: 'subToolUse',
      parent: 'w1',
      id: 'w2',
      name: 'Agent',
      input: { description: 'grep for errors' },
      subagent: null
    })
    chats.stop(c.id)
    await idle(c.id)
    expect((await metaOf(c.id)).group.lost).toEqual({ ui: ['scan the logs'], wk: ['review the diff'] })

    modAnswers = [par('ui'), none()]
    await svc.send(c.id, '@ui go on')
    await idle(c.id)
    expect(agentOf(calls[2])).toBe('ui')
    expect(calls[2].args).toContain('--resume')
    expect(calls[2].stdin.endsWith(`\n\n${lostNote(['scan the logs'])}`)).toBe(true)
    expect(calls[2].stdin).not.toContain('review the diff')
    expect((await metaOf(c.id)).group.lost).toEqual({ wk: ['review the diff'] })

    modAnswers = [par('wk'), none()]
    await svc.send(c.id, '@wk go on')
    await idle(c.id)
    expect(agentOf(calls[3])).toBe('wk')
    expect(calls[3].stdin.endsWith(`\n\n${lostNote(['review the diff'])}`)).toBe(true)
    expect((await metaOf(c.id)).group).not.toHaveProperty('lost')
    expect(JSON.stringify(await store.loadItems(c.id))).not.toContain('results are lost')
  })

  it("each member's subagents the CLI closes as failed while a Stop winds it down are still lost; one that came back done is not", async () => {
    const c = await group(['ui', 'wk'])
    // Stop does not end these runs: the test streams what each CLI sends while it winds down, then ends it.
    const winding = (): Script => ({
      hang: true,
      stubborn: true,
      events: [],
      outcome: { exitCode: null, signal: 'SIGINT', result: null, stopped: true }
    })
    scripts.ui = [winding()]
    scripts.wk = [winding()]
    modAnswers = [par('ui', 'wk')]
    await svc.send(c.id, '@ui @wk go')
    await until(() => calls.length === 2, 'both members to start')
    const aborted = (id: string): RunEvent => ({
      kind: 'toolResult',
      toolUseId: id,
      content: '[Request interrupted by user for tool use]',
      isError: true
    })
    liveOf('ui').emit({ kind: 'init', sessionId: 's-ui' })
    liveOf('ui').emit(agentCall('u1', 'scan the logs'))
    liveOf('wk').emit({ kind: 'init', sessionId: 's-wk' })
    liveOf('wk').emit(agentCall('w1', 'review the diff'))
    liveOf('wk').emit(agentCall('w2', 'write the notes'))
    chats.stop(c.id)
    liveOf('ui').emit(aborted('u1'))
    liveOf('wk').emit({ kind: 'toolResult', toolUseId: 'w2', content: 'written', isError: false })
    liveOf('wk').emit(aborted('w1'))
    liveOf('ui').finish()
    liveOf('wk').finish()
    await idle(c.id)
    expect((await metaOf(c.id)).group.lost).toEqual({ ui: ['scan the logs'], wk: ['review the diff'] })
  })

  it("a member's compact that is a cut run (after an Edit) clears only its lost, with no note; a plain one keeps it", async () => {
    const c = await group(['ui', 'wk'])
    // ui was rewound by an Edit it did not answer; wk resumes plainly.
    await store.updateGroup(c.id, (g) => ({
      ...g,
      sessions: { ui: 'sU1', wk: 'sW1' },
      next: { ui: { at: 'e1' } },
      lost: { ui: ['scan the logs'], wk: ['review the diff'] }
    }))
    scripts.ui = [{ events: [{ kind: 'init', sessionId: 'sU2' }, { kind: 'compacted', pre: 5000, post: 900 }, okResult] }]
    await svc.compact(c.id, 'ui', '')
    expect(calls[0].args).toContain('--resume-session-at')
    expect(calls[0].stdin).toBe('/compact')
    let g = (await metaOf(c.id)).group
    expect(g.lost).toEqual({ wk: ['review the diff'] })
    expect(g.next).toBeUndefined()
    // A plain compact neither tells nor clears.
    scripts.wk = [{ events: [{ kind: 'init', sessionId: 'sW1' }, { kind: 'compacted', pre: 5000, post: 900 }, okResult] }]
    await svc.compact(c.id, 'wk', '')
    expect(calls[1].args).not.toContain('--resume-session-at')
    expect(calls[1].stdin).toBe('/compact')
    expect((await metaOf(c.id)).group.lost).toEqual({ wk: ['review the diff'] })
    // ui's next turn resumes the compacted session plainly and is told nothing; wk's is told its own.
    modAnswers = [par('ui'), none()]
    await svc.send(c.id, '@ui go on')
    await idle(c.id)
    expect(agentOf(calls[2])).toBe('ui')
    expect(calls[2].args).not.toContain('--resume-session-at')
    expect(calls[2].stdin).not.toContain('results are lost')
    modAnswers = [par('wk'), none()]
    await svc.send(c.id, '@wk go on')
    await idle(c.id)
    expect(calls[3].stdin.endsWith(`\n\n${lostNote(['review the diff'])}`)).toBe(true)
    g = (await metaOf(c.id)).group
    expect(g).not.toHaveProperty('lost')
  })

  it('an Edit rewinds the members: their next turns get no note and clear lost', async () => {
    const c = await group(['ui', 'wk'])
    await store.saveItems(c.id, [
      { type: 'user', id: 'u1', text: 'first', ts: 1 },
      { type: 'assistant', id: 'a1', text: 'ui one', ts: 2, agent: 'ui', end: { agent: 'ui', session: 'sU1', at: 'e1', seen: 'u1' } },
      { type: 'user', id: 'u2', text: 'second', ts: 3 },
      { type: 'notice', id: 'n2', kind: 'stopped', text: 'Stopped', ts: 4 }
    ])
    await store.updateGroup(c.id, (g) => ({ ...g, sessions: { ui: 'sU2' }, seen: { ui: 'u2' }, lost: { ui: ['scan the logs'] } }))
    scripts.ui = [
      {
        events: [{ kind: 'init', sessionId: 'sU3' }, { kind: 'entry', uuid: 'g1' }, { kind: 'assistantText', text: 'ui better' }, okResult]
      }
    ]
    modAnswers = [par('ui'), none()]
    await svc.rerun(c.id, 'u2', 'second, better')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui'])
    expect(calls[0].args).toContain('--resume-session-at')
    expect(calls[0].stdin).not.toContain('results are lost')
    expect((await metaOf(c.id)).group).not.toHaveProperty('lost')
  })
})

describe('GroupService with Codex members', () => {
  const DEF = { body: 'You are the Codex member.', model: 'gpt-6-sol' }
  const KEY = 'tok-secret-ABCD1234'
  const mcpOf = (name: string): McpServerSpec => ({ name, command: '/n', args: ['/b.mjs'], passEnv: [], fixedEnv: {} })
  let codexCalls: CodexRunOptions[]
  let codexScripts: Script[]
  let codexAgents: Set<string>
  const engineOf = async (agent: string): Promise<Engine> => (codexAgents.has(agent) ? 'codex' : 'claude')
  // A Codex turn as the runner emits it: the thread, the reply, then the turn's id before the result.
  const cxTurn = (thread: string, text: string, turn: string): Script => ({
    events: [{ kind: 'init', sessionId: thread }, { kind: 'assistantText', text }, { kind: 'entry', uuid: turn }, okResult]
  })
  const codexRun = (o: CodexRunOptions): RunHandle => {
    codexCalls.push(o)
    const s = codexScripts.shift() ?? cxTurn('th-new', 'cx done', 'turn-x')
    let release: (x: RunOutcome) => void = () => {}
    const done = new Promise<RunOutcome>((resolve) => {
      release = resolve
    })
    const finish = () => {
      s.events?.forEach((e) => o.onEvent(e))
      release(baseOutcome(s.outcome))
    }
    live.push({ finish, emit: (e) => o.onEvent(e) })
    if (!s.hang) setImmediate(finish)
    return { stop: () => release(baseOutcome({ exitCode: null, signal: 'SIGINT', result: null, stopped: true })), send: () => true, done }
  }
  const promptOf = (o: CodexRunOptions) => (o.action.kind === 'turn' ? textOf(o.action.prompt) : '')
  const notices = (items: ChatItem[], kind: string) => items.filter((i) => i.type === 'notice' && i.kind === kind)
  // The ChatService and GroupService app.ts builds, with cx on Codex.
  const setup = (extra: Partial<ChatServiceDeps> = {}, caps?: (e: Engine) => EngineCaps) => {
    chats = new ChatService({
      ...chatDeps,
      engineOf,
      codex: {
        locate: async () => '/bin/codex',
        run: codexRun,
        definitionOf: async (agent) => (codexAgents.has(agent) ? { ...DEF } : null)
      },
      ...(caps ? { caps } : {}),
      ...extra
    })
    svc = new GroupService({
      store,
      chats,
      files,
      agents: async () => agentList,
      engineOf,
      moderate: async (input, _cwd, signal, chatId) => {
        modChatIds.push(chatId)
        modInputs.push(input)
        modSignals.push(signal)
        const a = modAnswers.length > 0 ? modAnswers.shift()! : modFallback(input)
        if (a === 'hang') return new Promise<ModeratorAnswer | null>(() => {})
        return a
      },
      push: (p) => pushes.push(p),
      now: () => 1000 + n,
      newId: () => `x${++n}`,
      disallowedToolsFor: (a) => deny(a),
      ...(caps ? { caps } : {})
    })
  }
  // Real processes: a slower wait than the in-process fakes need.
  const idleLong = async (id: string) => {
    for (let i = 0; i < 750 && chats.isRunning(id); i++) await sleep(20)
    expect(chats.isRunning(id)).toBe(false)
  }
  const briefingOf = (member: string, members: string[], role = '') =>
    buildBriefing(
      member,
      members.map((name) => ({ name, description: `${name} role` })),
      dir,
      role
    )

  beforeEach(() => {
    codexCalls = []
    codexScripts = []
    codexAgents = new Set(['cx'])
    agentList = [...agentList, { ...agentSummary('cx'), provider: 'codex' }]
    setup()
  })

  it("a Codex member's turn runs on codex with the room briefing after its body, its thread is marked, and the next turn resumes it", async () => {
    const c = await group(['ui', 'cx'])
    codexScripts = [cxTurn('th-1', 'cx one', 'turn-1'), cxTurn('th-1', 'cx two', 'turn-2')]
    modAnswers = [par('ui', 'cx'), none(), none()]
    await svc.send(c.id, 'hello')
    await idle(c.id)
    expect(calls.map(agentOf)).toEqual(['ui'])
    expect(codexCalls).toHaveLength(1)
    const o = codexCalls[0]
    expect(o).toMatchObject({ bin: '/bin/codex', cwd: dir, start: { kind: 'new' } })
    expect(o.thread.baseInstructions).toBe([DEF.body, briefingOf('cx', ['ui', 'cx']), RUN_SYSTEM].join('\n\n'))
    expect(promptOf(o)).toContain('hello')
    const g = (await metaOf(c.id)).group
    expect(g.sessions).toEqual({ ui: 's-ui', cx: 'th-1' })
    expect(g.sessionEngines).toEqual({ cx: 'codex' })
    const items = await store.loadItems(c.id)
    expect(assistants(items).find((i) => i.agent === 'cx')).toMatchObject({
      text: 'cx one',
      end: { session: 'th-1', at: 'turn-1', agent: 'cx', engine: 'codex' }
    })
    expect(assistants(items).find((i) => i.agent === 'ui')?.end).toBeUndefined() // the fake claude reports no entry
    modAnswers = [par('cx'), none()]
    await svc.send(c.id, 'again')
    await idle(c.id)
    expect(codexCalls[1].start).toEqual({ kind: 'resume', threadId: 'th-1' })
    expect(calls.map(agentOf)).toEqual(['ui'])
    // The moderator routed both messages, as a separate call: it is never a codex run (only the two member turns are).
    expect(modInputs.length).toBeGreaterThanOrEqual(2)
    expect(modInputs[0].members.map((m) => m.name)).toEqual(['ui', 'cx'])
    expect(codexCalls.map(promptOf).every((p) => p.includes('hello') || p.includes('again'))).toBe(true)
  })

  it("a member's engine switch reseeds only that member, with the expired notice, and neither CLI is handed the other's session", async () => {
    const c = await group(['ui', 'wk'])
    modAnswers = [par('ui', 'wk'), none(), none()]
    await svc.send(c.id, 'one')
    await idle(c.id)
    expect((await metaOf(c.id)).group.sessions).toEqual({ ui: 's-ui', wk: 's-wk' })
    // wk moves to Codex in Agent Studio.
    codexAgents.add('wk')
    codexScripts = [cxTurn('th-w', 'wk on codex', 'turn-1')]
    modAnswers = [par('ui', 'wk'), none(), none()]
    await svc.send(c.id, 'two')
    await idle(c.id)
    const uiRuns = calls.filter((o) => agentOf(o) === 'ui')
    expect(uiRuns).toHaveLength(2)
    expect(argAfter(uiRuns[1].args, '--resume')).toBe('s-ui')
    expect(calls.filter((o) => agentOf(o) === 'wk')).toHaveLength(1)
    expect(codexCalls[0].start).toEqual({ kind: 'new' })
    expect(JSON.stringify(codexCalls[0])).not.toContain('s-wk')
    // Seeded from the room's history.
    expect(promptOf(codexCalls[0])).toContain('one')
    let items = await store.loadItems(c.id)
    expect(notices(items, 'expired')).toHaveLength(1)
    let g = (await metaOf(c.id)).group
    expect(g.sessions).toEqual({ ui: 's-ui', wk: 'th-w' })
    expect(g.sessionEngines).toEqual({ wk: 'codex' })
    // And back to Claude: a fresh Claude session, never --resume of the thread; the mark goes.
    codexAgents.delete('wk')
    modAnswers = [par('wk'), none()]
    await svc.send(c.id, 'three')
    await idle(c.id)
    const wkRun = calls.filter((o) => agentOf(o) === 'wk').at(-1)!
    expect(wkRun.args).not.toContain('--resume')
    expect(wkRun.args).not.toContain('th-w')
    items = await store.loadItems(c.id)
    expect(notices(items, 'expired')).toHaveLength(2)
    g = (await metaOf(c.id)).group
    expect(g.sessions).toEqual({ ui: 's-ui', wk: 's-wk' })
    expect(g).not.toHaveProperty('sessionEngines')
  })

  it('a room rewind forks the Codex member at its stamp and cuts the Claude member; switching back points both at the old version', async () => {
    const c = await group(['ui', 'cx'])
    const end = (agent: string, session: string, at: string, seen: string | null, engine?: 'codex') => ({
      agent,
      session,
      at,
      seen,
      ...(engine ? { engine } : {})
    })
    await store.saveItems(c.id, [
      { type: 'user', id: 'u1', text: 'first', ts: 1 },
      { type: 'assistant', id: 'a1', text: 'ui one', ts: 2, agent: 'ui', end: end('ui', 'sU1', 'e1', 'u1') },
      { type: 'assistant', id: 'c1', text: 'cx one', ts: 3, agent: 'cx', end: end('cx', 'th-1', 'turn-1', 'a1', 'codex') },
      { type: 'user', id: 'u2', text: 'second', ts: 4 },
      { type: 'assistant', id: 'a3', text: 'OLD ui answer', ts: 5, agent: 'ui', end: end('ui', 'sU2', 'e2', 'u2') },
      { type: 'assistant', id: 'c3', text: 'OLD cx answer', ts: 6, agent: 'cx', end: end('cx', 'th-1', 'turn-2', 'a3', 'codex') }
    ])
    await store.updateGroup(c.id, (g) => ({
      ...g,
      sessions: { ui: 'sU2', cx: 'th-1' },
      seen: { ui: 'u2', cx: 'a3' },
      sessionEngines: { cx: 'codex' }
    }))
    codexScripts = [cxTurn('th-2', 'cx better', 'turn-3')]
    modAnswers = [par('ui', 'cx'), none(), none()]
    await svc.rerun(c.id, 'u2', 'second, better')
    await idle(c.id)
    const ui = calls.find((o) => agentOf(o) === 'ui')!
    expect(ui.args.slice(ui.args.indexOf('--resume'), ui.args.indexOf('--resume') + 5)).toEqual([
      '--resume',
      'sU1',
      '--resume-session-at',
      'e1',
      '--fork-session'
    ])
    expect(codexCalls[0].start).toEqual({ kind: 'fork', threadId: 'th-1', lastTurnId: 'turn-1' })
    expect(JSON.stringify(codexCalls[0])).not.toContain('sU1')
    expect(notices(await store.loadItems(c.id), 'expired')).toHaveLength(0)
    let g = (await metaOf(c.id)).group
    expect(g.sessions).toEqual({ ui: 's-ui', cx: 'th-2' })
    expect(g.sessionEngines).toEqual({ cx: 'codex' })
    expect(g.next).toBeUndefined()
    // Back to the first version: each member points at that version's own stamps again, with their engines.
    await chats.switchVersion(c.id, (await store.loadItems(c.id)).find((i) => i.type === 'user' && i.text === 'second, better')!.id, 0)
    g = (await metaOf(c.id)).group
    expect(g.sessions).toEqual({ ui: 'sU2', cx: 'th-1' })
    expect(g.next).toEqual({ ui: { at: 'e2' }, cx: { at: 'turn-2' } })
    expect(g.sessionEngines).toEqual({ cx: 'codex' })
  })

  it('a rewind to a Claude stamp of a member now on Codex reseeds it rather than fork a Claude session on codex', async () => {
    const c = await group(['ui', 'wk'])
    await store.saveItems(c.id, [
      { type: 'user', id: 'u1', text: 'first', ts: 1 },
      { type: 'assistant', id: 'a1', text: 'wk one', ts: 2, agent: 'wk', end: { agent: 'wk', session: 'sW1', at: 'f1', seen: 'u1' } },
      { type: 'user', id: 'u2', text: 'second', ts: 3 }
    ])
    await store.updateGroup(c.id, (g) => ({ ...g, sessions: { wk: 'sW1' }, seen: { wk: 'u1' } }))
    codexAgents.add('wk')
    codexScripts = [cxTurn('th-w', 'wk on codex', 'turn-1')]
    modAnswers = [par('wk'), none()]
    await svc.rerun(c.id, 'u2', 'second, better')
    await idle(c.id)
    expect(codexCalls[0].start).toEqual({ kind: 'new' })
    expect(JSON.stringify(codexCalls[0])).not.toContain('sW1')
    expect(notices(await store.loadItems(c.id), 'expired')).toHaveLength(1)
    expect((await metaOf(c.id)).group).toMatchObject({ sessions: { wk: 'th-w' } })
    expect((await metaOf(c.id)).group.sessionEngines).toEqual({ wk: 'codex' })
  })

  it('a Codex member gets the vault hooks, its API keys and the pause hook as a single chat does, the bridges but no ask bridge', async () => {
    const PAUSE_ENTRY = fileURLToPath(new URL('../fixtures/pause-hook-src.mjs', import.meta.url))
    const PAUSE_HOOK = codexPauseHook({ node: process.execPath, pauseHookEntry: PAUSE_ENTRY, electronNode: false })!
    const VAULT = codexVaultHooks({ keyFile: '/h/.config/zumibot-vault/vault.key', vaultFile: '/d/vault.json', home: '/h' })
    const tmp = new ChatTmp(join(dir, 'claude-tmp'))
    setup({
      tmp,
      pauseHook: { settings: pauseSettings({ node: '/opt/node', entry: '/opt/pauseHook.mjs', electronNode: false }) },
      codexPauseHook: PAUSE_HOOK,
      codexVaultHooks: VAULT,
      vaultEnv: () => ({ env: { CB_TEST_VAULT_KEY: KEY }, scrub: new Map([[KEY, '[vault: Azure PAT]']]) }),
      todoTurns: {
        create: () => ({
          mcp: mcpOf('zumibot_todos'),
          args: ['--mcp-config', 'todo-config'],
          env: { ZUMIBOT_TODOS_CAPABILITY: 'todo-cap' },
          dispose: () => {}
        })
      },
      askTurns: {
        create: () => ({
          mcp: mcpOf('zumibot_agents'),
          args: ['--mcp-config', 'ask-config'],
          env: { ZUMIBOT_ASKS_CAPABILITY: 'ask-cap' },
          dispose: () => {}
        })
      },
      askRoster: async () => [{ name: 'b', description: 'Makes cards' }]
    })
    const c = await group(['ui', 'cx'])
    expect(await chats.canPause(c.id)).toBe(true)
    codexScripts = [cxTurn('th-1', 'cx one', 'turn-1')]
    modAnswers = [par('cx'), none()]
    await svc.send(c.id, 'hi')
    await idle(c.id)
    const o = codexCalls[0]
    expect(o.thread.hooks).toEqual([...VAULT, PAUSE_HOOK])
    expect(o.env?.CB_TEST_VAULT_KEY).toBe(KEY)
    expect(o.env?.ZUMIBOT_PAUSE_FILE).toBe(tmp.pauseFlagOf(c.id))
    expect(o.subagents).toBe(true)
    expect(o.thread.mcpServers.map((s) => s.name)).toEqual(['zumibot_todos'])
    expect(o.env).not.toHaveProperty('ZUMIBOT_ASKS_CAPABILITY')
    expect(o.thread.baseInstructions).toBe([DEF.body, briefingOf('cx', ['ui', 'cx']), TODO_SYSTEM, RUN_SYSTEM].join('\n\n'))
    expect(o.thread.baseInstructions).not.toContain('@b')
  })

  it('a Codex member whose hooks codex never confirms runs without them, after a notice naming that member', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const VAULT = codexVaultHooks({ keyFile: '/h/.config/zumibot-vault/vault.key', vaultFile: '/d/vault.json', home: '/h' })
      setup({
        codexVaultHooks: VAULT,
        vaultEnv: () => ({ env: { CB_TEST_VAULT_KEY: KEY }, scrub: new Map([[KEY, '[vault: Azure PAT]']]) })
      })
      const c = await group(['ui', 'cx'])
      const untrusted: Script = { outcome: { hooksUntrusted: true, result: null } }
      codexScripts = [untrusted, { ...untrusted }, cxTurn('th-1', 'cx one', 'turn-1')]
      modAnswers = [par('cx'), none()]
      await svc.send(c.id, 'hi')
      await idle(c.id)
      expect(codexCalls.map((o) => o.thread.hooks ?? null)).toEqual([VAULT, VAULT, null])
      const items = await store.loadItems(c.id)
      const notice = notices(items, 'unguarded')
      expect(notice).toEqual([
        expect.objectContaining({ text: unguardedNoticeText({ vault: true, keys: true, pause: false, member: 'Cx' }) })
      ])
      // Ahead of the member's reply, and signed by no agent, like every notice.
      expect(items.findIndex((i) => i.type === 'notice')).toBeLessThan(items.findIndex((i) => i.type === 'assistant'))
      expect(notice[0]).not.toHaveProperty('agent')
    } finally {
      log.mockRestore()
    }
  })

  it("Compact on a Codex member compacts its thread on codex; a member whose stored session is the other engine's has nothing to compact", async () => {
    const c = await group(['ui', 'cx'])
    codexScripts = [cxTurn('th-1', 'cx one', 'turn-1')]
    modAnswers = [par('ui', 'cx'), none(), none()]
    await svc.send(c.id, 'hello')
    await idle(c.id)
    codexScripts = [{ events: [{ kind: 'init', sessionId: 'th-1' }, { kind: 'compacted', pre: 150_000, post: 8_000 }, okResult] }]
    await svc.compact(c.id, 'cx', 'keep the plan')
    expect(codexCalls[1]).toMatchObject({ start: { kind: 'resume', threadId: 'th-1' }, action: { kind: 'compact' } })
    expect(calls.map(agentOf)).toEqual(['ui'])
    expect((await metaOf(c.id)).group).toMatchObject({ sessions: { cx: 'th-1' }, sessionEngines: { cx: 'codex' }, active: [] })
    // ui moves to Codex: its Claude session is nothing codex can compact, and claude never runs for it.
    codexAgents.add('ui')
    await expect(svc.compact(c.id, 'ui', '')).rejects.toThrow(NOTHING_TO_COMPACT)
    expect(codexCalls).toHaveLength(2)
    expect(calls).toHaveLength(1)
    // With Codex's Compact off, the Codex member's Compact is refused with the fixed sentence.
    codexAgents.delete('ui')
    setup({}, (e) => ({ ...engineCaps(e), ...(e === 'codex' ? { compact: false } : {}) }))
    await expect(svc.compact(c.id, 'cx', '')).rejects.toThrow(CODEX_REFUSALS.compact)
    expect(codexCalls).toHaveLength(2)
  })

  it('with Codex rooms off, the member turn and Compact refuse a Codex member again', async () => {
    setup({}, noCodexRooms)
    const c = await group(['ui', 'cx'])
    modAnswers = [par('ui', 'cx'), none()]
    await svc.send(c.id, 'hello')
    await idle(c.id)
    expect(codexCalls).toHaveLength(0)
    expect(await store.loadItems(c.id)).toContainEqual(expect.objectContaining({ type: 'error', text: CODEX_REFUSALS.room('cx') }))
    await expect(svc.compact(c.id, 'cx', '')).rejects.toThrow(CODEX_REFUSALS.room('cx'))
    await expect(svc.refuseCodex('cx')).rejects.toThrow(CODEX_REFUSALS.room('cx'))
  })

  it("over fake-codex: the member's thread starts with the briefing, the next turn resumes it, and Compact sends thread/compact/start", async () => {
    const fake = fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url))
    const bin = writeFakeBin(dir, 'codex-shim', fake)
    const home = join(dir, 'codex-home'),
      log = join(dir, 'codex-log.jsonl'),
      script = join(dir, 'codex-script.jsonl')
    mkdirSync(home, { recursive: true })
    writeFileSync(
      script,
      JSON.stringify({
        notify: {
          method: 'item/completed',
          params: { threadId: '$THREAD', turnId: '$TURN', item: { type: 'agentMessage', id: 'm1', text: 'cx over the fake' } }
        }
      }) + '\n'
    )
    const fakeEnv = { FAKE_CODEX_HOME: home, FAKE_CODEX_LOG: log, FAKE_CODEX_SCRIPT: script }
    setup({
      codex: {
        locate: async () => bin,
        run: (o) => runCodex({ ...o, env: { ...process.env, ...o.env, ...fakeEnv } }),
        definitionOf: async () => ({ ...DEF })
      }
    })
    const c = await group(['ui', 'cx'])
    modAnswers = [par('cx'), none()]
    await svc.send(c.id, '@cx hello')
    await idleLong(c.id)
    const sent = () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { method: string; params: any })
    const start = sent().find((l) => l.method === 'thread/start')!
    expect(start.params.baseInstructions).toBe([DEF.body, briefingOf('cx', ['ui', 'cx']), RUN_SYSTEM].join('\n\n'))
    const g = (await metaOf(c.id)).group
    expect(g.sessions.cx).toBe(sent().find((l) => l.method === 'turn/start')!.params.threadId)
    expect(g.sessionEngines).toEqual({ cx: 'codex' })
    expect(assistants(await store.loadItems(c.id)).map((i) => [i.agent, i.text])).toEqual([['cx', 'cx over the fake']])
    modAnswers = [par('cx'), none()]
    await svc.send(c.id, '@cx again')
    await idleLong(c.id)
    expect(
      sent()
        .filter((l) => l.method === 'thread/resume')
        .map((l) => l.params.threadId)
    ).toEqual([g.sessions.cx])
    await svc.compact(c.id, 'cx', '')
    expect(
      sent()
        .map((l) => l.method)
        .slice(-3)
    ).toEqual(['initialize', 'thread/resume', 'thread/compact/start'])
    expect(sent().at(-1)!.params.threadId).toBe(g.sessions.cx)
    expect(calls).toHaveLength(0)
  }, 30_000)
})

// An ACP agent as a room member: its turns run through the real runner against the fake agent, as app.ts wires it.
describe('GroupService with an ACP member', () => {
  const FAKE = fileURLToPath(new URL('../fixtures/fake-acp-agent.mjs', import.meta.url))
  const BODY = 'You are the ACP member.'
  const launch: AcpLaunch = { command: process.execPath, args: [FAKE], authEnv: [] }
  let acpCalls: AcpRunOptions[]
  let script: Record<string, unknown>
  const logFile = () => join(dir, 'acp-log.jsonl')
  const sent = (method: string): any[] => {
    let text = ''
    try {
      text = readFileSync(logFile(), 'utf8')
    } catch {
      /* no run yet */
    }
    return text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((m) => m.method === method)
  }
  const engineOf = async (agent: string): Promise<Engine> => (agent === 'gm' ? 'acp' : 'claude')
  const briefingOf = (member: string, members: string[]) =>
    buildBriefing(
      member,
      members.map((name) => ({ name, description: `${name} role` })),
      dir,
      ''
    )
  const acpRun = (o: AcpRunOptions) => {
    acpCalls.push(o)
    writeFileSync(join(dir, 'acp-script.json'), JSON.stringify(script))
    const base = {
      ...process.env,
      FAKE_ACP_SCRIPT: join(dir, 'acp-script.json'),
      FAKE_ACP_LOG: logFile(),
      FAKE_ACP_START: join(dir, 'acp-start.jsonl')
    }
    return startAcp({ ...o, env: { ...base, ...o.env }, killGraceMs: 200, killForceMs: 200 })
  }
  const idleLong = async (id: string) => {
    for (let i = 0; i < 750 && chats.isRunning(id); i++) await sleep(20)
    expect(chats.isRunning(id)).toBe(false)
  }

  beforeEach(async () => {
    acpCalls = []
    script = { sessionId: 'acp-s1', steps: [{ text: 'gm one' }] }
    agentList = [...agentList, { ...agentSummary('gm'), provider: 'acp' }]
    const trust = new LaunchTrust(join(dir, 'data'))
    await trust.load()
    await trust.confirm('gm', acpRecord(launch))
    chats = new ChatService({
      ...chatDeps,
      engineOf,
      acp: {
        definitionOf: async (agent) => (agent === 'gm' ? { provider: 'acp' as const, body: BODY, launch } : null),
        trust: (agent, l) => trust.check(agent, acpRecord(l)),
        locate: async (command) => command,
        run: acpRun
      }
    })
    svc = new GroupService({
      store,
      chats,
      files,
      agents: async () => agentList,
      engineOf,
      moderate: async (input, _cwd, signal, chatId) => {
        modChatIds.push(chatId)
        modInputs.push(input)
        modSignals.push(signal)
        const a = modAnswers.length > 0 ? modAnswers.shift()! : modFallback(input)
        return a === 'hang' ? new Promise<ModeratorAnswer | null>(() => {}) : a
      },
      push: (p) => pushes.push(p),
      now: () => 1000 + n,
      newId: () => `x${++n}`,
      disallowedToolsFor: (a) => deny(a)
    })
  })

  it('an ACP member answers through the fake agent with the room briefing in its first prompt, its session is marked acp, and the next turn resumes it', async () => {
    const c = await group(['ui', 'gm'])
    script = {
      sessionId: 'acp-s1',
      sessions: ['acp-s1'],
      initialize: { agentCapabilities: { sessionCapabilities: { resume: {} } } },
      steps: [{ text: 'gm one' }]
    }
    modAnswers = [par('ui', 'gm'), none(), none()]
    await svc.send(c.id, 'hello')
    await idleLong(c.id)
    // Only the Claude member ran on claude; the ACP member never did, and neither did the moderator (a separate call).
    expect(calls.map(agentOf)).toEqual(['ui'])
    expect(acpCalls).toHaveLength(1)
    expect(acpCalls[0]).toMatchObject({ bin: process.execPath, args: [FAKE], cwd: dir, start: { kind: 'new' } })
    const briefing = briefingOf('gm', ['ui', 'gm'])
    // The agent's body, then the room briefing: as Claude's append and Codex's baseInstructions order them.
    expect(acpCalls[0].systemPrompt).toBe([BODY, briefing, RUN_SYSTEM].join('\n\n'))
    // This fake takes no systemPrompt, so the whole of it leads the first prompt as the preamble.
    const first = sent('session/prompt')[0].params.prompt as { type: string; text: string }[]
    expect(first[0].text).toContain(BODY)
    expect(first[0].text).toContain(briefing)
    expect(first.map((b) => b.text).join('\n')).toContain('hello')
    const g = (await metaOf(c.id)).group
    expect(g.sessions).toEqual({ ui: 's-ui', gm: 'acp-s1' })
    expect(g.sessionEngines).toEqual({ gm: 'acp' })
    const items = await store.loadItems(c.id)
    // No rewind stamp: ACP reports no entry ids and a room with it offers no Edit, Resend or Fork.
    expect(assistants(items).find((i) => i.agent === 'gm')).toMatchObject({ text: 'gm one' })
    expect(assistants(items).find((i) => i.agent === 'gm')?.end).toBeUndefined()
    expect(modInputs[0].members.map((m) => m.name)).toEqual(['ui', 'gm'])
    // The next turn resumes the same session, with no second preamble.
    script = {
      sessionId: 'acp-s1',
      sessions: ['acp-s1'],
      initialize: { agentCapabilities: { sessionCapabilities: { resume: {} } } },
      steps: [{ text: 'gm two' }]
    }
    modAnswers = [par('gm'), none()]
    await svc.send(c.id, 'again')
    await idleLong(c.id)
    expect(acpCalls[1].start).toEqual({ kind: 'resume', sessionId: 'acp-s1' })
    expect(sent('session/resume')).toHaveLength(1)
    expect(sent('session/new')).toHaveLength(1)
    expect(calls.map(agentOf)).toEqual(['ui'])
    expect((await metaOf(c.id)).group.sessionEngines).toEqual({ gm: 'acp' })
  }, 30_000)

  it('a /todo message, or a command that makes to-dos, is refused for a room with an ACP member before anything is stored or run, a resend too', async () => {
    const c = await group(['ui', 'gm'])
    const refusal = todoRefusal('acp', 'gm')
    await expect(svc.send(c.id, '/todo plan', [], undefined, undefined, undefined, true)).rejects.toThrow(refusal)
    await expect(
      svc.send(c.id, '/day', [], undefined, undefined, { agent: 'ui', name: 'day', prompt: 'Plan', todos: true })
    ).rejects.toThrow(refusal)
    expect(await store.loadItems(c.id)).toEqual([])
    await store.saveItems(c.id, [
      { type: 'user', id: 'u1', text: '/todo plan', ts: 1, todo: true },
      { type: 'assistant', id: 'a1', agent: 'ui', text: 'ok', ts: 2 }
    ] as ChatItem[])
    await expect(svc.rerun(c.id, 'u1', null)).rejects.toThrow(refusal)
    expect((await store.loadItems(c.id)).map((i) => i.type)).toEqual(['user', 'assistant'])
    expect(chats.isRunning(c.id)).toBe(false)
    expect(calls).toHaveLength(0)
    expect(acpCalls).toHaveLength(0)
    expect(modInputs).toHaveLength(0)
    // A room of Claude members takes the same message as ever.
    const claudes = await group(['ui', 'wk'])
    modAnswers = [none()]
    await svc.send(claudes.id, '/todo plan', [], undefined, undefined, undefined, true)
    await idleLong(claudes.id)
    expect((await store.loadItems(claudes.id))[0]).toMatchObject({ type: 'user', todo: true })
  }, 30_000)

  it('an agent that takes systemPrompt gets body and room briefing in session/new, not in the prompt', async () => {
    const c = await group(['ui', 'gm'])
    script = {
      sessionId: 'acp-s1',
      initialize: { agentCapabilities: { sessionCapabilities: { systemPrompt: {} } } },
      steps: [{ text: 'gm one' }]
    }
    modAnswers = [par('gm'), none()]
    await svc.send(c.id, 'hello')
    await idleLong(c.id)
    const sys = sent('session/new')[0].params.systemPrompt
    expect(sys.content[0].text).toBe([BODY, briefingOf('gm', ['ui', 'gm']), RUN_SYSTEM].join('\n\n'))
    const prompt = sent('session/prompt')[0].params.prompt as { text: string }[]
    expect(prompt.map((b) => b.text).join('\n')).not.toContain(BODY)
  }, 30_000)

  it('a member whose agent moved from Claude to ACP reseeds alone, with the expired notice, and is never handed the Claude session', async () => {
    const c = await group(['ui', 'wk'])
    modAnswers = [par('ui', 'wk'), none(), none()]
    await svc.send(c.id, 'one')
    await idleLong(c.id)
    expect((await metaOf(c.id)).group.sessions).toEqual({ ui: 's-ui', wk: 's-wk' })
    const moved = async (agent: string): Promise<Engine> => (agent === 'wk' ? 'acp' : 'claude')
    agentList = agentList.map((a) => (a.name === 'wk' ? { ...a, provider: 'acp' as const } : a))
    const trust = new LaunchTrust(join(dir, 'data2'))
    await trust.load()
    await trust.confirm('wk', acpRecord(launch))
    chats = new ChatService({
      ...chatDeps,
      engineOf: moved,
      acp: {
        definitionOf: async () => ({ provider: 'acp' as const, body: BODY, launch }),
        trust: (a, l) => trust.check(a, acpRecord(l)),
        locate: async (cmd) => cmd,
        run: acpRun
      }
    })
    svc = new GroupService({
      store,
      chats,
      files,
      agents: async () => agentList,
      engineOf: moved,
      moderate: async () => (modAnswers.length > 0 ? ((await modAnswers.shift()) as ModeratorAnswer) : none()),
      push: (p) => pushes.push(p),
      now: () => 1000 + n,
      newId: () => `x${++n}`,
      disallowedToolsFor: (a) => deny(a)
    })
    script = { sessionId: 'acp-w', steps: [{ text: 'wk on acp' }] }
    modAnswers = [par('wk'), none()]
    await svc.send(c.id, 'two')
    await idleLong(c.id)
    expect(acpCalls[0].start).toEqual({ kind: 'new' })
    expect(JSON.stringify(sent('session/new'))).not.toContain('s-wk')
    expect(JSON.stringify(sent('session/prompt'))).toContain('one')
    expect((await store.loadItems(c.id)).filter((i) => i.type === 'notice' && i.kind === 'expired')).toHaveLength(1)
    const g = (await metaOf(c.id)).group
    expect(g.sessions.wk).toBe('acp-w')
    expect(g.sessionEngines).toEqual({ wk: 'acp' })
  }, 30_000)
})
