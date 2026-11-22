import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join, resolve } from 'node:path'
import { ChatStore } from '../../src/core/store/chatStore'
import { ApprovalStore } from '../../src/core/store/approvalStore'
import { checkPrefix, continueText } from '@zumibot/shared/allowRules'
import { AttachmentStore } from '../../src/core/attachments/attachmentStore'
import { SnapshotStore } from '../../src/core/files/snapshotStore'
import { branch } from '../../src/core/chat/versions'
import {
  ALREADY_ALLOWED,
  CHAT_BUSY,
  ChatService,
  FORK_IGNORED,
  NOT_ALLOWABLE,
  NOTHING_TO_COMPACT,
  notePrivateValues,
  type ChatServiceDeps,
  type LiveSpend,
  type RunCostEvent,
  type SideBase
} from '../../src/core/chat/chatService'
import type { BrowserHandoff, BrowserOwner } from '../../src/core/browser/types'
import { HOUSE_STYLE } from '../../src/core/chat/houseStyle'
import { serveBrowserIpc } from '../../src/core/browser/browserIpc'
import { BrowserCapabilities } from '../../src/core/browser/browserCapabilities'
import { DESKTOP_ASK_RULES, serveDesktopIpc, type DesktopTurn } from '../../src/core/desktop/desktopIpc'
import type { DesktopPlan } from '../../src/core/desktop/desktopApplication'
import { desktopPrompt, desktopUnavailablePrompt } from '../../src/core/desktop/desktopPrompt'
import { DESKTOP_ACTION_TOOLS, desktopToolName, type DesktopHandoff, type DesktopOwner } from '@zumibot/shared/desktop'
import { refsOf, withNote, withNotes } from '../../src/core/attachments/content'
import { buildSeedPrompt, makeTitle } from '../../src/core/chat/seedPrompt'
import { APPROVAL_REQUIRED, parseLine, type RunEvent } from '../../src/core/chat/streamParser'
import { DispatchService } from '../../src/core/dispatch/dispatchService'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  allowKey,
  allowResponse,
  denyResponse,
  errorResponse,
  planSentBack,
  ruleOf,
  SKIPPED_BY_USER
} from '../../src/core/chat/controlProtocol'
import { buildArgs, type RunHandle, type RunOptions, type RunOutcome } from '../../src/core/chat/claudeRunner'
import { NOTICE_TEXT, type AgentRule, type Attachment, type ChatItem, type ChatPush } from '@zumibot/shared/types'
import type { TurnEnd } from '@zumibot/shared/notify'
import { applyPush, emptyChatView } from '../support/chatView'
import { writeFakeBin } from '../support/fakeBin'
import { writePreludeBin } from '../support/chatFakeBin'

// The vault guard's deny rule for the key folder used below, in the CLI's //absolute form (`/c/...` for a Windows drive path).
const KEY_DIR_RULE = `Read(/${process.platform === 'win32' ? gitBashPath(resolve('/home/u/.config/zumibot-vault')) : '/home/u/.config/zumibot-vault'}/**)`
import { TodoService } from '../../src/core/todos/todoService'
import type { TodoOwner, TodoTurn } from '../../src/core/todos/todoIpc'
import type { VaultApprovalRequest } from '@zumibot/shared/vault'
import { TODO_SYSTEM } from '../../src/core/todos/todoPrompt'
import type { AskOwner, AskTurn } from '../../src/core/asks/askIpc'
import { serveVaultIpc, type VaultOwner, type VaultTurn } from '../../src/core/vault/vaultIpc'
import { VAULT_SYSTEM } from '../../src/core/vault/vaultPrompt'
import type { VaultAgentItem } from '@zumibot/shared/vault'
import { ChatTmp } from '../../src/core/chat/chatTmp'
import { pauseSettings } from '../../src/core/chat/pauseSettings'
import { gitBashPath, vaultGuardSettings } from '../../src/core/vault/vaultGuard'
import { PAUSE_UNAVAILABLE, TaskQueue } from '../../src/core/chat/taskQueue'
import { PAUSE_BLOCK_TEXT, PAUSE_MARKER, RESUME_TEXT, lostNote } from '@zumibot/shared/pause'
import { askedSystem, askSystem, QUESTIONS_DENIED } from '../../src/core/asks/askPrompt'
import { TASK_QUESTIONS_DENIED } from '../../src/core/todos/taskPrompt'
import { workflowSystem } from '../../src/core/workflows/workflowPrompt'
import { ASK_SIDE_TOOL, ASK_TOOL } from '@zumibot/shared/agentAsk'
import { AUTOMATION_PREFIX, CONFIRM_ONLY_TOOLS, WRITE_REFUSED } from '@zumibot/shared/automations'
import { AUTOMATION_ASK_SETTINGS } from '../../src/core/automations/automationTools'
import type { AutomationTurn } from '../../src/core/automations/automationIpc'
import type { AutomationOwner } from '../../src/core/automations/automationService'
import { NO_MCP, type McpServerSpec } from '../../src/core/ipc/mcpSpec'
import { SideQuestions } from '../../src/core/btw/sideQuestions'
import { runCodex, type CodexRunOptions } from '../../src/core/codex/codexRunner'
import { codexInput } from '../../src/core/codex/codexParams'
import { codexPauseHook, codexVaultHooks } from '../../src/core/codex/codexHooks'
import { CODEX_BLOCKED_TOOL } from '../../src/core/codex/codexEvents'
import { VAULT_GUARD_TEXT } from '../../src/core/vault/vaultGuard'
import { CODEX_REFUSALS, engineCaps, type Engine, type EngineCaps } from '@zumibot/shared/engine'
import { listChatFiles } from '@zumibot/shared/chatFiles'
import { CONNECTOR_IDS, connectorPrefixes, denyEntries, offRefusal, unattendedRefusal, type ConnectorId } from '@zumibot/shared/connectors'
import { stepRuleOf } from '@zumibot/shared/stepRules'
import { NO_EXTENSIONS, type AgentExtensions } from '@zumibot/shared/extensions'
import type { VaultItem } from '@zumibot/shared/vault'
import { buildAgentRunConfig, NO_RUN_CONFIG, type AgentRunConfig } from '../../src/core/extensions/agentRunConfig'
import { sideArgs, startSideRun } from '../../src/core/btw/sideRun'
import { vaultEnvOf } from '../../src/core/vault/vaultEnv'

// act: async work the CLI does before its events (an MCP tool call reaching the server, say).
// end: set by the runner on a hanging script, to end it as its outcome says (a normal end, unlike stop()).
// onStop: what the CLI streams while a stop winds it down, before it exits (sent once, by the first stop).
interface Script {
  events?: RunEvent[]
  outcome?: Partial<RunOutcome>
  hang?: boolean
  ready?: () => void
  act?: () => Promise<void>
  end?: () => void
  onStop?: RunEvent[]
}

const okResult: RunEvent = {
  kind: 'result',
  subtype: 'success',
  isError: false,
  numTurns: 1,
  sessionId: 's1',
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
const pong: RunEvent[] = [
  { kind: 'init', sessionId: 's1' },
  { kind: 'textDelta', text: 'po' },
  { kind: 'textDelta', text: 'ng' },
  { kind: 'assistantText', text: 'pong' },
  okResult
]

let dir: string
let store: ChatStore
let calls: RunOptions[]
let scripts: Script[]
let pushes: ChatPush[]
let located: string | null
let n: number
let svc: ChatService
let files: AttachmentStore
let sent: object[]
let sentVia: RunOptions[] // the run whose handle sent each message in `sent`
let sendOk: boolean
let emit: (e: RunEvent) => void
let mode: 'auto' | 'manual'
let idled: [string, boolean][]
let style: boolean
let rules: {
  has(agent: string, key: string): boolean
  add(agent: string, rule: AgentRule): void
  cli(agent: string): string[]
  addCli(agent: string, rule: string): Promise<void>
  added: [string, AgentRule][]
}

const makeService = (extra: Partial<ChatServiceDeps> = {}) =>
  new ChatService({
    store,
    files,
    locate: async () => located,
    run: (o) => {
      calls.push(o)
      emit = o.onEvent
      const s = scripts.shift() ?? { events: pong }
      let release: (o: RunOutcome) => void = () => {}
      const done = new Promise<RunOutcome>((resolve) => {
        release = resolve
        if (!s.hang) {
          const fire = () => {
            s.events?.forEach((e) => o.onEvent(e))
            resolve(baseOutcome(s.outcome))
          }
          setImmediate(() => {
            if (s.act) void s.act().then(fire)
            else fire()
          })
        } else {
          s.end = () => resolve(baseOutcome(s.outcome))
          setImmediate(() => {
            s.events?.forEach((e) => o.onEvent(e))
            s.ready?.()
          })
        }
      })
      return {
        stop: () => {
          const late = s.onStop
          s.onStop = undefined
          late?.forEach((e) => o.onEvent(e))
          release(baseOutcome({ exitCode: null, signal: 'SIGINT', result: null, stopped: true }))
        },
        send: (m: object) => {
          if (sendOk) {
            sent.push(m)
            sentVia.push(o)
          }
          return sendOk
        },
        done
      } as RunHandle
    },
    push: (p) => pushes.push(p),
    now: () => 1000 + n,
    newId: () => `x${++n}`,
    permissionMode: mode,
    disallowedToolsFor: (n) => (n === 'zumi-bot' ? ['Edit(//d/zumi-bot.md)'] : []),
    houseStyle: async () => style,
    agentRules: rules,
    onIdle: (id) => idled.push([id, svc.isRunning(id)]),
    ...extra
  })

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-svc-'))
  store = new ChatStore(dir)
  files = new AttachmentStore(join(dir, 'attachments'), () => 'unused')
  calls = []
  scripts = []
  pushes = []
  located = '/bin/claude'
  n = 0
  sent = []
  sentVia = []
  sendOk = true
  mode = 'auto'
  idled = []
  style = false
  const stored = new Set<string>()
  rules = {
    added: [],
    cli: () => [],
    addCli: async () => {},
    has: (a, k) => stored.has(`${a}\n${k}`),
    add(a, r) {
      this.added.push([a, r])
      stored.add(`${a}\n${r.key}`)
    }
  }
  svc = makeService()
})
afterEach(async () => {
  // A store write still finishing can refill a folder rm just emptied (ENOTEMPTY): rm retries that itself.
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

const tick = () => new Promise((r) => setTimeout(r, 20))
// Queues a hanging script and resolves once its events are in. A fixed tick() before stop() was too short on a slow
// Windows runner, so the turn was stopped before it had started.
const hangUntilReady = (events?: RunEvent[]) =>
  new Promise<void>((ready) => scripts.push({ hang: true, events, ready }))
const itemsOf = async (id: string) => store.loadItems(id)

describe('ChatService', () => {
  it('send carries auto into the turn spec only when told to', async () => {
    const c = await store.create('helper', dir)
    const turn = vi.spyOn(svc, 'agentTurn')
    await svc.send(c.id, 'typed')
    await svc.send(c.id, 'tick', [], undefined, undefined, undefined, undefined, true)
    const first = (await itemsOf(c.id))[0]
    await svc.rerun(c.id, first.id, 'edited')
    const specs = turn.mock.calls.map((a) => a[2])
    expect(specs).toHaveLength(3)
    expect(specs[0]).not.toHaveProperty('auto')
    expect(specs[1].auto).toBe(true)
    expect(specs[2]).not.toHaveProperty('auto')
  })

  it('an agent list that cannot be read keeps the message, with the error after it, and runs nothing', async () => {
    svc = makeService({
      engineOf: async () => {
        throw new Error('agents folder unreadable')
      }
    })
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'keep me')
    const items = await itemsOf(c.id)
    expect(items.map((i) => i.type)).toEqual(['user', 'error'])
    expect(items[0]).toMatchObject({ type: 'user', text: 'keep me' })
    expect(items[1]).toMatchObject({ type: 'error', text: expect.stringContaining('agents folder unreadable') })
    expect(calls).toHaveLength(0)
    expect(await store.get(c.id)).toMatchObject({ inFlight: false, title: 'keep me' })
    // A resend keeps the list it had: its new version is never half-made.
    await svc.rerun(c.id, items[0].id, null)
    const after = await itemsOf(c.id)
    expect(after.slice(0, 2)).toEqual(items)
    expect(after.map((i) => i.type)).toEqual(['user', 'error', 'error'])
    expect(calls).toHaveLength(0)
  })

  it("passes the agent's deny rules to the CLI", async () => {
    const c = await store.create('zumi-bot', dir)
    await svc.send(c.id, 'ping')
    expect(calls[0].args.slice(-2)).toEqual(['--disallowedTools', 'Edit(//d/zumi-bot.md)'])
    const other = await store.create('helper', dir)
    await svc.send(other.id, 'ping')
    expect(calls[1].args).not.toContain('--disallowedTools')
  })

  it('house style goes to the system prompt only while on, fresh on resume', async () => {
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'one')
    expect(calls[0].args).not.toContain('--append-system-prompt')
    expect(calls[0].args).not.toContain('--system-prompt-snapshot')
    style = true
    await svc.send(c.id, 'two')
    const args = calls[1].args
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe(HOUSE_STYLE)
    expect(args[args.indexOf('--system-prompt-snapshot') + 1]).toBe('off')
    expect(args).toContain('--resume')
    expect(calls[1].stdin).toBe('two')
    style = false
    await svc.send(c.id, 'three')
    expect(calls[2].args).not.toContain('--append-system-prompt')
  })

  it('new chat runs fresh and stores session, title, items', async () => {
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'ping')
    expect(calls).toHaveLength(1)
    expect(calls[0].bin).toBe('/bin/claude')
    expect(calls[0].args).not.toContain('--resume')
    expect(calls[0].args.slice(0, 3)).toEqual(['-p', '--agent', 'helper'])
    expect(calls[0].stdin).toBe('ping')
    expect(calls[0].cwd).toBe(dir)
    const meta = await store.get(c.id)
    expect(meta).toMatchObject({ sessionId: 's1', title: makeTitle('ping'), inFlight: false })
    expect((await itemsOf(c.id)).map((i) => i.type)).toEqual(['user', 'assistant'])
    expect(svc.isRunning(c.id)).toBe(false)
  })

  it('a burst of events writes the chat once, not once per event', async () => {
    const c = await store.create('helper', dir)
    const tools: RunEvent[] = Array.from({ length: 10 }, (_, i) => ({ kind: 'toolUse', id: `t${i}`, name: 'Bash', input: {} }))
    scripts.push({ events: [{ kind: 'init', sessionId: 's1' }, ...tools, { kind: 'assistantText', text: 'done' }, okResult] })
    const save = vi.spyOn(store, 'saveItems')
    await svc.send(c.id, 'go')
    // The user's message, the burst, and the end of the turn.
    expect(save.mock.calls.length).toBeLessThanOrEqual(3)
    expect((await itemsOf(c.id)).map((i) => i.type)).toEqual(['user', ...tools.map(() => 'tool'), 'assistant'])
    // Every event still pushes: the user's message, 10 tools, the text, the result and the end of the turn.
    expect(pushes.filter((p) => p.kind === 'items')).toHaveLength(14)
  })

  it('keeps the id the client picked for its message, unless an item already has it', async () => {
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'ping', [], undefined, 'm-1')
    await svc.send(c.id, 'again', [], undefined, 'm-1')
    const users = (await itemsOf(c.id)).filter((i) => i.type === 'user')
    expect(users[0].id).toBe('m-1')
    expect(users[1].id).not.toBe('m-1')
  })

  it('a reply quotes the agent message to the CLI and keeps its id on the user message', async () => {
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'ping')
    const answer = (await itemsOf(c.id)).find((i) => i.type === 'assistant')!
    await svc.send(c.id, 'why?', [], answer.id)
    expect(calls[1].stdin).toBe('<reply_to>\npong\n</reply_to>\n\nwhy?')
    const items = await itemsOf(c.id)
    expect(items[2]).toMatchObject({ type: 'user', text: 'why?', replyTo: answer.id })
  })

  it('the agent reads the command prompt, the chat keeps the short form', async () => {
    const c = await store.create('helper', dir)
    const command = { agent: 'helper', name: 'check', prompt: 'Use check on L' }
    await svc.send(c.id, '/check L', [], undefined, undefined, command)
    expect(calls[0].stdin).toBe('Use check on L')
    expect((await itemsOf(c.id))[0]).toMatchObject({ type: 'user', text: '/check L', command })
  })

  it('a reply quote goes in front of the command prompt', async () => {
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'ping')
    const answer = (await itemsOf(c.id)).find((i) => i.type === 'assistant')!
    await svc.send(c.id, '/check L', [], answer.id, undefined, { agent: 'helper', name: 'check', prompt: 'Use check on L' })
    expect(calls[1].stdin).toBe('<reply_to>\npong\n</reply_to>\n\nUse check on L')
  })

  it('a reseed shows the agent the prompt of its own earlier command', async () => {
    const c = await store.create('helper', dir)
    await store.update(c.id, { sessionId: 'old' })
    const prior: ChatItem[] = [
      { type: 'user', id: 'u0', text: '/check L', ts: 1, command: { agent: 'helper', name: 'check', prompt: 'Use check on L' } },
      { type: 'assistant', id: 'a0', text: 'hi', ts: 2 }
    ]
    await store.saveItems(c.id, prior)
    scripts.push({
      outcome: {
        exitCode: 1,
        stderr: 'No conversation found with session ID: old',
        result: {
          kind: 'result',
          subtype: 'error_during_execution',
          isError: true,
          numTurns: 0,
          sessionId: '',
          denials: [],
          windows: {},
          uuid: null,
          cost: null
        }
      }
    })
    scripts.push({ events: [{ kind: 'init', sessionId: 'new' }, { kind: 'assistantText', text: 'pong' }, okResult] })
    await svc.send(c.id, 'ping')
    expect(calls[1].stdin).toContain('User: Use check on L')
    expect(calls[1].stdin).not.toContain('/check L')
  })

  describe('a usage limit hit', () => {
    const limitResult: RunEvent = {
      kind: 'result',
      subtype: 'success',
      isError: true,
      numTurns: 1,
      sessionId: 's1',
      denials: [],
      windows: {},
      uuid: null,
      cost: null
    }

    it('stamps the error item with the reset, so a routine can wait for it', async () => {
      const c = await store.create('helper', dir)
      scripts.push({
        events: [
          { kind: 'init', sessionId: 's1' },
          { kind: 'limited', resetsAt: 5_000_000 },
          { kind: 'assistantText', text: "You've hit your session limit" },
          limitResult
        ],
        outcome: { exitCode: 1, result: limitResult as RunOutcome['result'] }
      })
      await svc.send(c.id, 'ping')
      expect((await itemsOf(c.id)).find((i) => i.type === 'error')).toMatchObject({ limit: { resetsAt: 5_000_000 } })
    })

    it('leaves a turn that went on to succeed unstamped', async () => {
      const c = await store.create('helper', dir)
      scripts.push({
        events: [
          { kind: 'init', sessionId: 's1' },
          { kind: 'limited', resetsAt: 5_000_000 },
          { kind: 'assistantText', text: 'pong' },
          okResult
        ]
      })
      await svc.send(c.id, 'ping')
      expect((await itemsOf(c.id)).some((i) => i.type === 'error')).toBe(false)
    })

    it('leaves a turn that failed without one unstamped', async () => {
      const c = await store.create('helper', dir)
      scripts.push({
        events: [{ kind: 'init', sessionId: 's1' }, limitResult],
        outcome: { exitCode: 1, result: limitResult as RunOutcome['result'] }
      })
      await svc.send(c.id, 'ping')
      expect((await itemsOf(c.id)).find((i) => i.type === 'error')).not.toHaveProperty('limit')
    })

    it('marks a compact the limit stopped, so it never makes the chat continue by itself', async () => {
      const c = await store.create('helper', dir)
      await svc.send(c.id, 'ping')
      scripts.push({
        events: [{ kind: 'init', sessionId: 's1' }, { kind: 'limited', resetsAt: 5_000_000 }, limitResult],
        outcome: { exitCode: 1, result: limitResult as RunOutcome['result'] }
      })
      await svc.compact(c.id, '')
      expect((await itemsOf(c.id)).find((i) => i.type === 'error')).toMatchObject({ limit: { resetsAt: 5_000_000, compact: true } })
    })
  })

  it('a reply to an id that is no agent message is sent as plain text', async () => {
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'ping')
    const user = (await itemsOf(c.id))[0]
    await svc.send(c.id, 'again', [], user.id)
    expect(calls[1].stdin).toBe('again')
    expect((await itemsOf(c.id))[2]).not.toHaveProperty('replyTo')
  })

  it('second send resumes', async () => {
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'ping')
    await svc.send(c.id, 'again')
    expect(calls[1].args).toContain('--resume')
    expect(calls[1].args[calls[1].args.indexOf('--resume') + 1]).toBe('s1')
  })

  it('pushes deltas before final items', async () => {
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'ping')
    const kinds = pushes.map((p) => (p.kind === 'items' ? `items:${p.clearStreaming}` : p.kind === 'delta' ? `delta:${p.text}` : 'meta'))
    const first = kinds.indexOf('delta:po')
    expect(first).toBeGreaterThan(-1)
    expect(kinds[first + 1]).toBe('delta:ng')
    expect(kinds.indexOf('items:true')).toBeGreaterThan(first + 1)
  })

  it('streams thinking as thought deltas and keeps each block as its own item, timed from its first delta', async () => {
    const c = await store.create('helper', dir)
    scripts.push({
      events: [
        { kind: 'init', sessionId: 's1' },
        { kind: 'thinkingDelta', text: 'Checking ' },
        { kind: 'thinkingDelta', text: 'the file.' },
        { kind: 'thinking', text: 'Checking the file.' },
        { kind: 'textDelta', text: 'done' },
        { kind: 'assistantText', text: 'done' },
        okResult
      ]
    })
    await svc.send(c.id, 'go')
    const thoughts = pushes.filter((p) => p.kind === 'delta' && p.thought)
    expect(thoughts.map((p) => (p as { text: string }).text)).toEqual(['Checking ', 'the file.'])
    // The reply's own deltas are never marked as thought.
    expect(pushes.filter((p) => p.kind === 'delta' && !p.thought).map((p) => (p as { text: string }).text)).toEqual(['done'])
    const items = await itemsOf(c.id)
    expect(items.map((i) => i.type)).toEqual(['user', 'thinking', 'assistant'])
    const thought = items[1] as Extract<ChatItem, { type: 'thinking' }>
    expect(thought.text).toBe('Checking the file.')
    expect(thought.doneTs).toBeGreaterThanOrEqual(thought.ts)
    // The push that keeps it clears the live thought.
    const kept = pushes.findIndex((p) => p.kind === 'items' && p.items.some((i) => i.type === 'thinking'))
    expect(kept).toBeGreaterThan(pushes.indexOf(thoughts[1]))
    expect((pushes[kept] as { clearStreaming: boolean }).clearStreaming).toBe(true)
  })

  it("a thought that names its start (Codex's reasoning) is timed from it, never after its end", async () => {
    const c = await store.create('helper', dir)
    scripts.push({
      events: [
        { kind: 'init', sessionId: 's1' },
        { kind: 'thinking', text: 'Early.', startedAt: 10 },
        { kind: 'thinking', text: 'From the future.', startedAt: 9e15 },
        { kind: 'assistantText', text: 'done' },
        okResult
      ]
    })
    await svc.send(c.id, 'go')
    const [early, future] = (await itemsOf(c.id)).filter((i) => i.type === 'thinking') as Extract<ChatItem, { type: 'thinking' }>[]
    expect(early.ts).toBe(10)
    expect(future.ts).toBe(future.doneTs)
  })

  it('passes --thinking-display only when the CLI takes it, and the side base carries it for side runs', async () => {
    const asked: string[] = []
    svc = makeService({
      thinkingDisplay: async (bin) => {
        asked.push(bin)
        return true
      }
    })
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'go')
    expect(asked).toEqual(['/bin/claude'])
    expect(calls[0].args).toEqual(expect.arrayContaining(['--thinking-display', 'summarized']))
    const base = svc.sideBase(c.id, 'helper')!
    expect(base.args.thinking).toBe(true)
    expect(sideArgs(base, null, null)).toEqual(expect.arrayContaining(['--thinking-display', 'summarized']))
    for (const answer of [
      async () => false,
      async () => {
        throw new Error('probe failed')
      }
    ]) {
      calls = []
      svc = makeService({ thinkingDisplay: answer })
      const d = await store.create('helper', dir)
      await svc.send(d.id, 'go')
      expect(calls[0].args).not.toContain('--thinking-display')
      expect(svc.sideBase(d.id, 'helper')!.args).not.toHaveProperty('thinking')
    }
  })

  it('scrubs vault values from thinking, a value split across two thought deltas too', async () => {
    const KEY = 'tok-secret-ABCD1234'
    svc = makeService({ vaultEnv: () => ({ env: {}, scrub: new Map([[KEY, '[vault: Token]']]) }) })
    const c = await store.create('helper', dir)
    scripts.push({
      events: [
        { kind: 'init', sessionId: 's1' },
        { kind: 'thinkingDelta', text: 'Using tok-secret-' },
        { kind: 'thinkingDelta', text: 'ABCD1234 for the call.' },
        { kind: 'thinking', text: `Using ${KEY} for the call.` },
        { kind: 'assistantText', text: 'done' },
        okResult
      ]
    })
    await svc.send(c.id, 'go')
    expect(JSON.stringify(pushes)).not.toContain('ABCD1234')
    const streamed = pushes
      .filter((p) => p.kind === 'delta' && p.thought)
      .map((p) => (p as { text: string }).text)
      .join('')
    expect(streamed).toBe('Using [vault: Token] for the call.')
    expect((await itemsOf(c.id)).find((i) => i.type === 'thinking')).toMatchObject({ text: 'Using [vault: Token] for the call.' })
  })

  it('blocked tool via approval text', async () => {
    const c = await store.create('helper', dir)
    scripts.push({
      events: [
        { kind: 'init', sessionId: 's1' },
        { kind: 'toolUse', id: 't1', name: 'Bash', input: { command: 'rm x' } },
        { kind: 'toolResult', toolUseId: 't1', content: APPROVAL_REQUIRED, isError: true },
        { ...(okResult as object), denials: [{ toolUseId: 't1', toolName: 'Bash' }] } as RunEvent
      ]
    })
    await svc.send(c.id, 'go')
    const tool = (await itemsOf(c.id)).find((i) => i.type === 'tool')
    expect(tool).toMatchObject({ id: 't1', blocked: true, result: APPROVAL_REQUIRED, isError: true })
  })

  it('stamps a tool with the time its result arrived', async () => {
    const c = await store.create('helper', dir)
    scripts.push({
      events: [
        { kind: 'toolUse', id: 't1', name: 'Bash', input: {} },
        { kind: 'toolUse', id: 't2', name: 'Bash', input: {} },
        // The fake clock ticks on each new id: the text moves it from 1001 to 1002.
        { kind: 'assistantText', text: 'hm' },
        { kind: 'toolResult', toolUseId: 't1', content: 'ok', isError: false },
        okResult
      ]
    })
    await svc.send(c.id, 'go')
    const tools = (await itemsOf(c.id)).filter((i) => i.type === 'tool')
    expect(tools[0]).toMatchObject({ id: 't1', ts: 1001, doneTs: 1002 })
    expect(tools[1]).not.toHaveProperty('doneTs')
  })

  it('blocked tool via denials only', async () => {
    const c = await store.create('helper', dir)
    scripts.push({
      events: [
        { kind: 'toolUse', id: 't1', name: 'Bash', input: {} },
        { kind: 'toolResult', toolUseId: 't1', content: 'denied somehow', isError: true },
        { ...(okResult as object), denials: [{ toolUseId: 't1', toolName: 'Bash' }] } as RunEvent
      ]
    })
    await svc.send(c.id, 'go')
    expect((await itemsOf(c.id)).find((i) => i.type === 'tool')).toMatchObject({ blocked: true, result: 'denied somehow' })
  })

  it('classifier refusal marks the tool blockedBy classifier; other refusals do not', async () => {
    const c = await store.create('helper', dir)
    scripts.push({
      events: [
        { kind: 'toolUse', id: 't1', name: 'Bash', input: { command: 'rm x' } },
        { kind: 'denied', toolUseId: 't1', reasonType: 'classifier' },
        { kind: 'toolResult', toolUseId: 't1', content: 'Permission denied by classifier', isError: true },
        { kind: 'toolUse', id: 't2', name: 'Bash', input: { command: 'rm y' } },
        { kind: 'denied', toolUseId: 't2', reasonType: 'other' },
        { kind: 'toolResult', toolUseId: 't2', content: APPROVAL_REQUIRED, isError: true },
        { kind: 'denied', toolUseId: 'unknown', reasonType: 'classifier' }, // a subagent's call has no top-level row
        { ...(okResult as object), denials: [{ toolUseId: 't1', toolName: 'Bash' }, { toolUseId: 't2', toolName: 'Bash' }] } as RunEvent
      ]
    })
    await svc.send(c.id, 'go')
    const tools = (await itemsOf(c.id)).filter((i) => i.type === 'tool')
    expect(tools[0]).toMatchObject({ id: 't1', blocked: true, blockedBy: 'classifier' })
    expect(tools[1]).toMatchObject({ id: 't2', blocked: true })
    expect(tools[1]).not.toHaveProperty('blockedBy')
  })

  it('expired session falls back once', async () => {
    const c = await store.create('helper', dir)
    await store.update(c.id, { sessionId: 'old' })
    const prior: ChatItem[] = [
      { type: 'user', id: 'u0', text: 'hello', ts: 1 },
      { type: 'assistant', id: 'a0', text: 'hi', ts: 2 }
    ]
    await store.saveItems(c.id, prior)
    scripts.push({
      outcome: {
        exitCode: 1,
        stderr: 'No conversation found with session ID: old',
        result: {
          kind: 'result',
          subtype: 'error_during_execution',
          isError: true,
          numTurns: 0,
          sessionId: '',
          denials: [],
          windows: {},
          uuid: null,
          cost: null
        }
      }
    })
    scripts.push({ events: [{ kind: 'init', sessionId: 'new' }, { kind: 'assistantText', text: 'pong' }, okResult] })
    await svc.send(c.id, 'ping')
    expect(calls).toHaveLength(2)
    expect(calls[0].args).toContain('--resume')
    expect(calls[1].args).not.toContain('--resume')
    expect(calls[1].stdin).toBe(buildSeedPrompt(prior, 'ping'))
    const items = await itemsOf(c.id)
    const types = items.map((i) => (i.type === 'notice' ? `notice:${i.kind}` : i.type))
    expect(types).toEqual(['user', 'assistant', 'user', 'notice:expired', 'assistant'])
    expect((await store.get(c.id))?.sessionId).toBe('new')
  })

  it('expired twice gives error and no third run', async () => {
    const c = await store.create('helper', dir)
    await store.update(c.id, { sessionId: 'old' })
    const missing = { exitCode: 1, stderr: 'No conversation found with session ID: old', result: null }
    scripts.push({ outcome: missing }, { outcome: missing })
    await svc.send(c.id, 'ping')
    expect(calls).toHaveLength(2)
    const items = await itemsOf(c.id)
    expect(items[items.length - 1]).toMatchObject({ type: 'error' })
  })

  it('stop ends the turn with a stopped notice', async () => {
    const c = await store.create('helper', dir)
    const up = hangUntilReady()
    const p = svc.send(c.id, 'ping')
    await up
    await tick()
    expect(svc.isRunning(c.id)).toBe(true)
    svc.stop(c.id)
    await p
    const items = await itemsOf(c.id)
    expect(items[items.length - 1]).toMatchObject({ type: 'notice', kind: 'stopped' })
    expect((await store.get(c.id))?.inFlight).toBe(false)
  })

  it('onIdle fires once after a turn ends, with the chat already idle', async () => {
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'ping')
    expect(idled).toEqual([[c.id, false]])
  })

  it('onIdle fires after a stopped turn too', async () => {
    const c = await store.create('helper', dir)
    const up = hangUntilReady()
    const p = svc.send(c.id, 'ping')
    await up
    await tick()
    svc.stop(c.id)
    await p
    expect(idled).toEqual([[c.id, false]])
  })

  describe('ensureFolder', () => {
    it('a turn awaits ensureFolder before spawning', async () => {
      const order: string[] = []
      const s = makeService({
        ensureFolder: async (id) => {
          order.push(`ensure:${id}`)
          await tick()
          order.push('ensured')
          return null
        },
        run: (o) => {
          order.push('spawn')
          return svc['d'].run(o)
        }
      })
      const c = await store.create('helper', dir)
      await s.send(c.id, 'ping')
      expect(order).toEqual([`ensure:${c.id}`, 'ensured', 'spawn'])
    })

    it("ensureFolder's notice becomes a worktree notice item before the reply", async () => {
      const text = "Branch b was gone, so it was made again from p's current HEAD."
      const s = makeService({ ensureFolder: async () => text })
      const c = await store.create('helper', dir)
      await s.send(c.id, 'ping')
      const items = await itemsOf(c.id)
      const at = items.findIndex((i) => i.type === 'notice')
      expect(items[at]).toMatchObject({ type: 'notice', kind: 'worktree', text })
      expect(items.findIndex((i) => i.type === 'assistant')).toBeGreaterThan(at)
    })

    it('a throwing ensureFolder ends the turn with that error text', async () => {
      const msg = 'Branch x is checked out in /p. Switch that checkout to another branch, then send again.'
      const s = makeService({
        ensureFolder: async () => {
          throw new Error(msg)
        }
      })
      const c = await store.create('helper', dir)
      await s.send(c.id, 'ping')
      const items = await itemsOf(c.id)
      expect(items[items.length - 1]).toMatchObject({ type: 'error', text: msg })
      expect(calls).toHaveLength(0)
      expect((await store.get(c.id))?.inFlight).toBe(false)
    })
  })

  it('stop before the run starts still ends stopped without spawning', async () => {
    const c = await store.create('helper', dir)
    const p = svc.send(c.id, 'ping')
    svc.stop(c.id)
    await p
    expect(calls).toHaveLength(0)
    const items = await itemsOf(c.id)
    expect(items[items.length - 1]).toMatchObject({ type: 'notice', kind: 'stopped' })
    expect((await store.get(c.id))?.inFlight).toBe(false)
  })

  it('rejects second send while running', async () => {
    const c = await store.create('helper', dir)
    scripts.push({ hang: true })
    const p = svc.send(c.id, 'one')
    await expect(svc.send(c.id, 'two')).rejects.toThrow('Chat is already running')
    svc.stop(c.id)
    await p
  })

  it('rejects same-tick double send', async () => {
    const c = await store.create('helper', dir)
    const a = svc.send(c.id, 'one')
    const b = svc.send(c.id, 'two')
    await expect(b).rejects.toThrow('Chat is already running')
    await a
    expect(calls).toHaveLength(1)
  })

  it('send to unknown chat rejects and leaves nothing running', async () => {
    await expect(svc.send('nope', 'x')).rejects.toThrow()
    expect(svc.runningCount()).toBe(0)
  })

  it('stop unknown chat is a no-op', () => {
    expect(() => svc.stop('nope')).not.toThrow()
  })

  it('folder missing', async () => {
    const c = await store.create('helper', '/gone')
    scripts.push({ outcome: { exitCode: null, result: null, spawnError: 'Folder not found: /gone' } })
    await svc.send(c.id, 'ping')
    const items = await itemsOf(c.id)
    expect(items[items.length - 1]).toMatchObject({ type: 'error', text: 'Folder not found: /gone' })
    expect((await store.get(c.id))?.inFlight).toBe(false)
  })

  it('claude missing', async () => {
    located = null
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'ping')
    expect(calls).toHaveLength(0)
    const items = await itemsOf(c.id)
    expect(items[items.length - 1]).toMatchObject({
      type: 'error',
      text: 'Claude CLI not found. Set its path in the banner at the top of the window.'
    })
    expect((await store.get(c.id))?.inFlight).toBe(false)
  })

  it('killed by signal', async () => {
    const c = await store.create('helper', dir)
    scripts.push({ outcome: { exitCode: null, signal: 'SIGKILL', stderr: '', result: null, stopped: false } })
    await svc.send(c.id, 'ping')
    const items = await itemsOf(c.id)
    expect(items[items.length - 1]).toMatchObject({ type: 'error', text: 'Claude exited with code SIGKILL' })
  })

  it('stopAll interrupts every running chat', async () => {
    const a = await store.create('helper', dir)
    const b = await store.create('helper', dir)
    const upA = hangUntilReady()
    const upB = hangUntilReady()
    const pa = svc.send(a.id, 'one')
    const pb = svc.send(b.id, 'two')
    await Promise.all([upA, upB])
    await tick()
    expect(svc.runningCount()).toBe(2)
    await svc.stopAll()
    expect(svc.runningCount()).toBe(0)
    await Promise.all([pa, pb])
    for (const id of [a.id, b.id]) {
      const items = await itemsOf(id)
      expect(items[items.length - 1]).toMatchObject({ type: 'notice', kind: 'interrupted' })
      expect((await store.get(id))?.inFlight).toBe(false)
    }
  })

  it('retries a failed sessionId save at the end of the turn', async () => {
    const c = await store.create('helper', dir)
    const real = store.update.bind(store)
    let failed = false
    vi.spyOn(store, 'update').mockImplementation((id, patch) => {
      if (!failed && patch.sessionId) {
        failed = true
        return Promise.reject(new Error('disk full'))
      }
      return real(id, patch)
    })
    await svc.send(c.id, 'ping')
    expect(failed).toBe(true)
    expect((await store.get(c.id))?.sessionId).toBe('s1')
  })

  it('surfaces a sessionId save that keeps failing', async () => {
    const c = await store.create('helper', dir)
    const real = store.update.bind(store)
    vi.spyOn(store, 'update').mockImplementation((id, patch) =>
      patch.sessionId ? Promise.reject(new Error('disk full')) : real(id, patch)
    )
    await expect(svc.send(c.id, 'ping')).rejects.toThrow('disk full')
    expect((await store.get(c.id))?.inFlight).toBe(false)
    expect(svc.runningCount()).toBe(0)
  })

  it('delete while running resolves quietly and leaves no log', async () => {
    const c = await store.create('helper', dir)
    const up = hangUntilReady()
    const p = svc.send(c.id, 'ping')
    await up
    await tick()
    await store.remove(c.id)
    svc.stop(c.id)
    await expect(p).resolves.toBeUndefined()
    expect(svc.runningCount()).toBe(0)
    await expect(fs.access(join(dir, 'chats', `${c.id}.json`))).rejects.toThrow()
  })

  it('stop during attempt 1 prevents the expired-session retry', async () => {
    const c = await store.create('helper', dir)
    await store.update(c.id, { sessionId: 'old' })
    scripts.push({
      outcome: { exitCode: 1, stderr: 'No conversation found with session ID: old', result: null, stopped: true }
    })
    await svc.send(c.id, 'ping')
    expect(calls).toHaveLength(1)
    const items = await itemsOf(c.id)
    expect(items[items.length - 1]).toMatchObject({ type: 'notice', kind: 'stopped' })
  })

  describe('command model', () => {
    const card = { agent: 'helper', name: 'card', prompt: 'Make a card', model: 'sonnet' as const }
    const fix = { agent: 'helper', name: 'fix', prompt: 'Fix it', model: 'opus' as const }
    const modelOf = (o: RunOptions) => (o.args.includes('--model') ? o.args[o.args.indexOf('--model') + 1] : null)
    beforeEach(() => {
      svc = makeService({ agentModel: async () => 'opus' })
    })

    it('a command that starts the chat runs on its model, and the chat stays on it', async () => {
      const c = await store.create('helper', dir)
      scripts.push({ events: pong }, { events: pong })
      await svc.send(c.id, '/card x', [], undefined, undefined, card)
      expect(modelOf(calls[0])).toBe('sonnet')
      expect((await store.get(c.id))?.model).toBe('sonnet')
      await svc.send(c.id, 'and the due date')
      expect(modelOf(calls[1])).toBe('sonnet')
    })

    it("a stronger command switches the chat up to the agent's own model; a cheaper one never switches down", async () => {
      const c = await store.create('helper', dir)
      scripts.push({ events: pong }, { events: pong }, { events: pong })
      await svc.send(c.id, '/card x', [], undefined, undefined, card)
      await svc.send(c.id, '/fix x', [], undefined, undefined, fix)
      expect(modelOf(calls[1])).toBeNull()
      expect((await store.get(c.id))?.model).toBeUndefined()
      await svc.send(c.id, '/card y', [], undefined, undefined, card)
      expect(modelOf(calls[2])).toBeNull()
    })

    it('a command in a chat that already runs on the agent model keeps it', async () => {
      const c = await store.create('helper', dir)
      scripts.push({ events: pong }, { events: pong })
      await svc.send(c.id, 'hello')
      await svc.send(c.id, '/card x', [], undefined, undefined, card)
      expect(calls.map(modelOf)).toEqual([null, null])
      expect((await store.get(c.id))?.model).toBeUndefined()
    })

    it("compact and a side run use the chat's model, so they share its cache", async () => {
      const c = await store.create('helper', dir)
      scripts.push({ events: pong }, { events: [{ kind: 'init', sessionId: 's1' }, { ...(okResult as object) } as RunEvent] })
      await svc.send(c.id, '/card x', [], undefined, undefined, card)
      expect(svc.sideBase(c.id, 'helper')?.args.model).toBe('sonnet')
      await svc.compact(c.id, '')
      expect(modelOf(calls[1])).toBe('sonnet')
    })

    it("setModel null puts the chat back on the agent's model, where commands apply again", async () => {
      const c = await store.create('helper', dir)
      scripts.push({ events: pong }, { events: pong })
      await svc.send(c.id, '/card x', [], undefined, undefined, card)
      await svc.setModel(c.id, null)
      expect((await store.get(c.id))?.model).toBeUndefined()
      await svc.send(c.id, 'now the hard part')
      expect(modelOf(calls[1])).toBeNull()
    })

    it('a model picked by hand runs every turn, and commands no longer move it', async () => {
      const c = await store.create('helper', dir)
      scripts.push({ events: pong }, { events: pong }, { events: pong })
      await svc.setModel(c.id, 'haiku')
      expect(await store.get(c.id)).toMatchObject({ model: 'haiku', modelByHand: true })
      await svc.send(c.id, '/card x', [], undefined, undefined, card)
      await svc.send(c.id, '/fix x', [], undefined, undefined, fix)
      await svc.send(c.id, 'plain')
      expect(calls.map(modelOf)).toEqual(['haiku', 'haiku', 'haiku'])
      expect(await store.get(c.id)).toMatchObject({ model: 'haiku', modelByHand: true })
    })

    it("picking Default by hand drops the pick, so the next command's model applies", async () => {
      const c = await store.create('helper', dir)
      scripts.push({ events: pong })
      await svc.setModel(c.id, 'haiku')
      await svc.setModel(c.id, null)
      const meta = await store.get(c.id)
      expect(meta?.model).toBeUndefined()
      expect(meta?.modelByHand).toBeUndefined()
      await svc.send(c.id, '/card x', [], undefined, undefined, card)
      expect(modelOf(calls[0])).toBe('sonnet')
    })

    it('setModel pushes the meta, and leaves a room alone', async () => {
      const c = await store.create('helper', dir)
      const before = pushes.length
      await svc.setModel(c.id, 'sonnet')
      expect(pushes.slice(before)).toEqual([
        expect.objectContaining({ chatId: c.id, kind: 'meta', meta: expect.objectContaining({ model: 'sonnet', modelByHand: true }) })
      ])
      const g = await store.createGroup(['helper', 'other'], dir, '')
      await svc.setModel(g.id, 'sonnet')
      expect((await store.get(g.id))?.model).toBeUndefined()
    })
  })

  describe('chat mode and effort', () => {
    const argOf = (o: RunOptions, flag: string) => (o.args.includes(flag) ? o.args[o.args.indexOf(flag) + 1] : null)

    it("a chat's own mode and effort start its turns; without them the turn runs the server's mode and Medium", async () => {
      const c = await store.create('helper', dir)
      scripts.push({ events: pong }, { events: pong })
      await svc.send(c.id, 'a')
      await svc.setPermissionMode(c.id, 'acceptEdits')
      await svc.setEffort(c.id, 'max')
      await svc.send(c.id, 'b')
      expect([argOf(calls[0], '--permission-mode'), argOf(calls[0], '--effort')]).toEqual(['auto', 'medium'])
      expect([argOf(calls[1], '--permission-mode'), argOf(calls[1], '--effort')]).toEqual(['acceptEdits', 'max'])
    })

    it('null puts the chat back on the defaults, and each change pushes the meta', async () => {
      const c = await store.create('helper', dir)
      const before = pushes.length
      await svc.setPermissionMode(c.id, 'plan')
      await svc.setEffort(c.id, 'low')
      expect(await store.get(c.id)).toMatchObject({ permissionMode: 'plan', effort: 'low' })
      expect(pushes.slice(before)).toEqual([
        expect.objectContaining({ kind: 'meta', meta: expect.objectContaining({ permissionMode: 'plan' }) }),
        expect.objectContaining({ kind: 'meta', meta: expect.objectContaining({ effort: 'low' }) })
      ])
      await svc.setPermissionMode(c.id, null)
      await svc.setEffort(c.id, null)
      const meta = await store.get(c.id)
      expect([meta?.permissionMode, meta?.effort]).toEqual([undefined, undefined])
      // Setting what the chat already has pushes nothing; Medium is the default, so it is not stored.
      const now = pushes.length
      await svc.setEffort(c.id, null)
      await svc.setEffort(c.id, 'medium')
      expect(pushes.length).toBe(now)
    })

    it('a room keeps its members on their defaults', async () => {
      const g = await store.createGroup(['helper', 'other'], dir, '')
      await svc.setPermissionMode(g.id, 'plan')
      await svc.setEffort(g.id, 'max')
      const meta = await store.get(g.id)
      expect([meta?.permissionMode, meta?.effort]).toEqual([undefined, undefined])
    })

    it("compact and a side run use the chat's effort, so they share its cache; a side run keeps its own mode", async () => {
      const c = await store.create('helper', dir)
      await svc.setPermissionMode(c.id, 'plan')
      await svc.setEffort(c.id, 'high')
      scripts.push({ events: [{ kind: 'init', sessionId: 's1' }, { ...(okResult as object) } as RunEvent] }, { events: pong })
      await svc.send(c.id, 'a')
      expect(svc.sideBase(c.id, 'helper')?.args).toMatchObject({ effort: 'high', permissionMode: 'auto' })
      await svc.compact(c.id, '')
      expect(argOf(calls[1], '--effort')).toBe('high')
    })
  })

  describe('chat temp folder', () => {
    const withTmp = () => {
      const tmp = new ChatTmp(join(dir, 'claude-tmp'))
      svc = makeService({ tmp })
      return tmp
    }

    it("gives a turn the chat's CLAUDE_CODE_TMPDIR, made before the run, and keeps it in the side base", async () => {
      const tmp = withTmp()
      const c = await store.create('helper', dir)
      await svc.send(c.id, 'ping')
      expect(calls[0].env?.CLAUDE_CODE_TMPDIR).toBe(tmp.dirOf(c.id))
      await expect(fs.access(tmp.dirOf(c.id))).resolves.toBeUndefined()
      expect(svc.sideBase(c.id, 'helper')?.tmpDir).toBe(tmp.dirOf(c.id))
    })

    it('a compact run has it too', async () => {
      const tmp = withTmp()
      const c = await store.create('helper', dir)
      scripts.push({ events: pong })
      await svc.send(c.id, 'ping')
      scripts.push({ events: pong })
      await svc.compact(c.id, '')
      expect(calls[1].stdin).toBe('/compact')
      expect(calls[1].env?.CLAUDE_CODE_TMPDIR).toBe(tmp.dirOf(c.id))
    })

    it("an asked run has the A to B chat's own folder", async () => {
      const tmp = withTmp()
      const a = await store.create('a', dir)
      const b = await store.create('b', dir)
      await store.update(b.id, { asked: { by: 'a', from: a.id, fromTitle: 'Issue chat', chain: ['a'] } })
      expect(
        await svc.runAsked(b.id, { from: 'a', message: 'make a card', chain: ['a'], parent: a.id, signal: new AbortController().signal })
      ).toMatchObject({ kind: 'ok' })
      expect(calls[0].env?.CLAUDE_CODE_TMPDIR).toBe(tmp.dirOf(b.id))
      expect(tmp.dirOf(b.id)).not.toBe(tmp.dirOf(a.id))
    })

    it('without the dep a run is exactly as before', async () => {
      const c = await store.create('helper', dir)
      await svc.send(c.id, 'ping')
      expect(calls[0].env).toBeUndefined()
      expect(svc.sideBase(c.id, 'helper')?.tmpDir).toBeNull()
    })

    it('the folder joins the other env parts', async () => {
      const tmp = withTmp()
      svc = makeService({ tmp, compactWindow: async () => 400000 })
      const c = await store.create('helper', dir)
      await svc.send(c.id, 'ping')
      expect(calls[0].env).toMatchObject({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000', CLAUDE_CODE_TMPDIR: tmp.dirOf(c.id) })
    })
  })

  it('tells keep warm about every saved context of a request, with the agent and its time', async () => {
    const seen: [string, string, number | null, number | undefined][] = []
    svc = makeService({ onContext: (chatId, agent, c) => seen.push([chatId, agent, c.used, c.at]) })
    const c = await store.create('helper', dir)
    scripts.push({
      events: [
        { kind: 'init', sessionId: 's1' },
        { kind: 'context', model: 'm', tokens: 150_000 },
        { kind: 'assistantText', text: 'pong' },
        okResult
      ]
    })
    await svc.send(c.id, 'ping')
    expect(seen).toEqual([[c.id, 'helper', 150_000, expect.any(Number)]])
  })

  describe('compact window', () => {
    it("passes the agent's compact window to its run as the CLI's env var", async () => {
      const asked: string[] = []
      svc = makeService({
        compactWindow: async (agent) => {
          asked.push(agent)
          return 400000
        }
      })
      const c = await store.create('helper', dir)
      scripts.push({ events: pong })
      await svc.send(c.id, 'ping')
      expect(asked).toEqual(['helper'])
      expect(calls[0].env).toMatchObject({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000' })
    })

    it('an agent without one runs as before', async () => {
      svc = makeService({ compactWindow: async () => null })
      const c = await store.create('helper', dir)
      scripts.push({ events: pong })
      await svc.send(c.id, 'ping')
      expect(calls[0].env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined()
    })

    it('a failing lookup never fails the turn', async () => {
      svc = makeService({
        compactWindow: async () => {
          throw new Error('EACCES')
        }
      })
      const c = await store.create('helper', dir)
      scripts.push({ events: pong })
      await svc.send(c.id, 'ping')
      expect(calls[0].env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined()
      expect((await itemsOf(c.id)).map((i) => i.type)).toEqual(['user', 'assistant'])
    })
  })

  describe('usage hooks', () => {
    const cost = { totalUsd: 0.5, models: { 'claude-sonnet-5': { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, costUsd: 0.5 } } }
    const costly = (uuid: string | null = 'r1'): RunEvent => ({ ...(okResult as object), uuid, cost }) as unknown as RunEvent
    let costs: RunCostEvent[]
    let bare: [string, string | null, string][]
    beforeEach(() => {
      costs = []
      bare = []
      svc = makeService({ onRunCost: (e) => costs.push(e), onRunWithoutCost: (c, s, a) => bare.push([c, s, a]) })
    })

    it("prices each request's growth as it streams, then drops the attempt's estimate at its end (spend caps)", async () => {
      const live: LiveSpend[] = []
      const ended: string[] = []
      svc = makeService({ onRunCost: (e) => costs.push(e), spend: { live: (e) => live.push(e), ended: (a) => ended.push(a) } })
      const c = await store.create('helper', dir)
      scripts.push({
        events: [
          { kind: 'init', sessionId: 's1' },
          // One request's content block lines repeat its usage so far: only the growth is new, and no growth adds nothing.
          { kind: 'spend', id: 'msg_1', usd: 0.01 },
          { kind: 'spend', id: 'msg_1', usd: 0.03 },
          { kind: 'spend', id: 'msg_1', usd: 0.03 },
          { kind: 'spend', id: 'msg_2', usd: 0.02 },
          { kind: 'assistantText', text: 'pong' },
          costly()
        ]
      })
      await svc.send(c.id, 'ping')
      expect(live.map((e) => [e.chatId, e.agent])).toEqual([
        [c.id, 'helper'],
        [c.id, 'helper'],
        [c.id, 'helper']
      ])
      for (const [i, usd] of [0.01, 0.02, 0.02].entries()) expect(live[i]!.usd).toBeCloseTo(usd, 12)
      expect(new Set(live.map((e) => e.attempt)).size).toBe(1)
      // The turn answers the user's message: a routine run or workflow step counts only its own turns by it.
      const asked = (await itemsOf(c.id)).find((i) => i.type === 'user')!
      expect(live.every((e) => e.message === asked.id)).toBe(true)
      // Dropped as the exact cost arrives (so no check counts both), and again at the attempt's end, which is harmless.
      expect(ended).toEqual([live[0]!.attempt, live[0]!.attempt])
      expect(costs).toHaveLength(1)
    })

    it("reports each attempt's cost with the turn's window and agent", async () => {
      const c = await store.create('helper', dir)
      scripts.push({ events: [{ kind: 'init', sessionId: 's1' }, { kind: 'assistantText', text: 'pong' }, costly()] })
      await svc.send(c.id, 'ping')
      expect(costs).toHaveLength(1)
      expect(costs[0]).toMatchObject({ chatId: c.id, agent: 'helper', sessionId: 's1', id: 'r1', cost })
      const [t0, t1] = costs[0].window
      expect(t0).toBeGreaterThan(1000)
      expect(t1).toBeGreaterThanOrEqual(t0)
      expect(bare).toEqual([])
    })

    it('a stopped turn reports no cost', async () => {
      const c = await store.create('helper', dir)
      const ready = hangUntilReady([{ kind: 'init', sessionId: 's1' }])
      const p = svc.send(c.id, 'ping')
      await ready
      svc.stop(c.id)
      await p
      expect(costs).toEqual([])
      expect(bare).toEqual([[c.id, 's1', expect.any(String)]])
    })

    it('a reseeded attempt reports both attempts', async () => {
      const c = await store.create('helper', dir)
      await store.update(c.id, { sessionId: 'old' })
      scripts.push({
        events: [costly('r1')],
        outcome: {
          exitCode: 1,
          stderr: 'No conversation found with session ID: old',
          result: {
            kind: 'result',
            subtype: 'error_during_execution',
            isError: true,
            numTurns: 0,
            sessionId: '',
            denials: [],
            windows: {},
            uuid: null,
            cost: null
          }
        }
      })
      scripts.push({
        events: [
          { kind: 'init', sessionId: 'new' },
          { kind: 'assistantText', text: 'pong' },
          { ...costly('r2'), sessionId: 'new' } as RunEvent
        ]
      })
      await svc.send(c.id, 'ping')
      expect(costs.map((e) => e.id)).toEqual(['r1', 'r2'])
      expect(costs[1].sessionId).toBe('new')
      expect(costs[1].window[0]).toBeGreaterThanOrEqual(costs[0].window[1])
      expect(costs[1].window[0]).not.toBe(costs[0].window[0])
    })

    it("a resumed turn reports only what it added to the session's restored cost", async () => {
      const read: string[] = []
      const base = { 'claude-sonnet-5': { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.25 } }
      svc = makeService({
        onRunCost: (e) => costs.push(e),
        costBaseline: async (id) => {
          read.push(id)
          return base
        }
      })
      const c = await store.create('helper', dir)
      await store.update(c.id, { sessionId: 'old' })
      scripts.push({ events: [{ kind: 'init', sessionId: 'old' }, { kind: 'assistantText', text: 'pong' }, costly()] })
      await svc.send(c.id, 'ping')
      expect(read).toEqual(['old'])
      expect(costs).toHaveLength(1)
      expect(costs[0].cost).toEqual({
        totalUsd: 0.25,
        models: { 'claude-sonnet-5': { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.25 } }
      })
    })

    it('a new session reads no baseline', async () => {
      const read: string[] = []
      svc = makeService({
        onRunCost: (e) => costs.push(e),
        costBaseline: async (id) => {
          read.push(id)
          return null
        }
      })
      const c = await store.create('helper', dir)
      scripts.push({ events: [{ kind: 'init', sessionId: 's1' }, { kind: 'assistantText', text: 'pong' }, costly()] })
      await svc.send(c.id, 'ping')
      expect(read).toEqual([])
      expect(costs[0].cost).toEqual(cost)
    })

    it('a baseline that cannot be read keeps the reported cost', async () => {
      svc = makeService({
        onRunCost: (e) => costs.push(e),
        costBaseline: async () => {
          throw new Error('EACCES')
        }
      })
      const c = await store.create('helper', dir)
      await store.update(c.id, { sessionId: 'old' })
      scripts.push({ events: [{ kind: 'init', sessionId: 'old' }, { kind: 'assistantText', text: 'pong' }, costly()] })
      await svc.send(c.id, 'ping')
      expect(costs[0].cost).toEqual(cost)
    })

    it('a throwing hook never breaks the turn', async () => {
      const c = await store.create('helper', dir)
      const onRunCost = vi.fn(() => {
        throw new Error('boom')
      })
      const onRunWithoutCost = vi.fn(() => {
        throw new Error('boom')
      })
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      svc = makeService({ onRunCost, onRunWithoutCost })
      scripts.push({ events: [{ kind: 'init', sessionId: 's1' }, { kind: 'assistantText', text: 'first' }, costly()] }, { events: pong })
      await svc.send(c.id, 'a')
      expect(onRunCost).toHaveBeenCalledTimes(1)
      expect((await itemsOf(c.id)).map((i) => i.type)).toEqual(['user', 'assistant'])
      await svc.send(c.id, 'b')
      expect(onRunWithoutCost).toHaveBeenCalledTimes(1)
      const items = await itemsOf(c.id)
      expect(items.filter((i) => i.type === 'error')).toEqual([])
      expect(items.filter((i) => i.type === 'assistant')).toHaveLength(2)
      expect(spy).toHaveBeenCalledTimes(2)
      spy.mockRestore()
    })

    it('a cost with no session id anywhere reports null', async () => {
      const c = await store.create('helper', dir)
      scripts.push({ events: [{ ...costly(), sessionId: '' } as RunEvent] })
      await svc.send(c.id, 'ping')
      expect(costs).toHaveLength(1)
      expect(costs[0].sessionId).toBeNull()
    })

    it('a result without cost leads to onRunWithoutCost', async () => {
      const c = await store.create('helper', dir)
      scripts.push({ events: pong })
      await svc.send(c.id, 'ping')
      expect(costs).toEqual([])
      expect(bare).toEqual([[c.id, 's1', expect.any(String)]])
    })

    it('a run that never reached init falls back to the session it resumed', async () => {
      const c = await store.create('helper', dir)
      await store.update(c.id, { sessionId: 'old' })
      const ready = hangUntilReady()
      const p = svc.send(c.id, 'ping')
      await ready
      svc.stop(c.id)
      await p
      expect(bare).toEqual([[c.id, 'old', expect.any(String)]])
    })

    it('a rename mid-turn changes the agent on the cost event', async () => {
      const c = await store.create('helper', dir)
      const ready = hangUntilReady([{ kind: 'init', sessionId: 's1' }])
      const p = svc.send(c.id, 'ping')
      await ready
      svc.renameAgent('helper', 'renamed')
      emit(costly())
      svc.stop(c.id)
      await p
      expect(costs[0].agent).toBe('renamed')
    })
  })

  describe('partial streamed text', () => {
    const shape = (items: ChatItem[]) => items.map((i) => (i.type === 'notice' ? `notice:${i.kind}` : i.type))
    const streamingAfter = (log: ChatPush[]) => log.reduce(applyPush, emptyChatView).streaming
    const partialEvents: RunEvent[] = [
      { kind: 'textDelta', text: 'par' },
      { kind: 'textDelta', text: 'tial' }
    ]

    it('stop after deltas keeps the partial reply before the stopped notice and clears streaming', async () => {
      const c = await store.create('helper', dir)
      scripts.push({ hang: true, events: partialEvents })
      const p = svc.send(c.id, 'ping')
      // Stop only once the deltas have streamed: one fixed tick is not enough on a loaded machine.
      await vi.waitFor(() => expect(streamingAfter(pushes)).toBe('partial'), { timeout: 5000 })
      svc.stop(c.id)
      await p
      const items = await itemsOf(c.id)
      expect(shape(items)).toEqual(['user', 'assistant', 'notice:stopped'])
      expect(items[1]).toMatchObject({ type: 'assistant', text: 'partial' })
      const lastItems = [...pushes].reverse().find((x) => x.kind === 'items')
      expect(lastItems).toMatchObject({ clearStreaming: true })
      expect(streamingAfter(pushes)).toBe('')
    })

    it('the next send does not carry the old partial', async () => {
      const c = await store.create('helper', dir)
      const up = hangUntilReady(partialEvents)
      const p = svc.send(c.id, 'ping')
      await up
      await tick()
      svc.stop(c.id)
      await p
      const mark = pushes.length
      await svc.send(c.id, 'again')
      const log = pushes.slice(mark)
      expect(log.some((x) => x.kind === 'delta' && x.text.includes('partial'))).toBe(false)
      expect(streamingAfter(pushes.slice(0, mark))).toBe('')
      expect(shape(await itemsOf(c.id))).toEqual(['user', 'assistant', 'notice:stopped', 'user', 'assistant'])
    })

    it('stopAll keeps the partial before the interrupted notice', async () => {
      const c = await store.create('helper', dir)
      const up = hangUntilReady(partialEvents)
      const p = svc.send(c.id, 'ping')
      await up
      await tick()
      await svc.stopAll()
      await p
      expect(shape(await itemsOf(c.id))).toEqual(['user', 'assistant', 'notice:interrupted'])
      expect(streamingAfter(pushes)).toBe('')
    })

    it('an error outcome after deltas keeps the partial before the error', async () => {
      const c = await store.create('helper', dir)
      scripts.push({ events: partialEvents, outcome: { exitCode: 1, stderr: 'boom', result: null } })
      await svc.send(c.id, 'ping')
      const items = await itemsOf(c.id)
      expect(shape(items)).toEqual(['user', 'assistant', 'error'])
      expect(items[1]).toMatchObject({ text: 'partial' })
      expect(items[2]).toMatchObject({ text: 'boom' })
      expect(streamingAfter(pushes)).toBe('')
    })

    it('an expired attempt that streamed text keeps it before the expired notice', async () => {
      const c = await store.create('helper', dir)
      await store.update(c.id, { sessionId: 'old' })
      scripts.push({
        events: partialEvents,
        outcome: { exitCode: 1, stderr: 'No conversation found with session ID: old', result: null }
      })
      scripts.push({ events: [{ kind: 'assistantText', text: 'pong' }, okResult] })
      await svc.send(c.id, 'ping')
      expect(shape(await itemsOf(c.id))).toEqual(['user', 'assistant', 'notice:expired', 'assistant'])
      const afterExpired = pushes.findIndex((x) => x.kind === 'items' && x.items.some((i) => i.type === 'notice'))
      expect(pushes[afterExpired]).toMatchObject({ clearStreaming: true })
    })

    it('a completed reply is not duplicated by its own deltas', async () => {
      const c = await store.create('helper', dir)
      await svc.send(c.id, 'ping')
      expect(shape(await itemsOf(c.id))).toEqual(['user', 'assistant'])
    })

    it('text after the last complete message is kept, earlier text is not repeated', async () => {
      const c = await store.create('helper', dir)
      scripts.push({
        events: [
          { kind: 'textDelta', text: 'one' },
          { kind: 'assistantText', text: 'one' },
          { kind: 'textDelta', text: 'two' }
        ],
        outcome: { exitCode: 1, stderr: 'x', result: null }
      })
      await svc.send(c.id, 'ping')
      const items = await itemsOf(c.id)
      expect(items.filter((i) => i.type === 'assistant').map((i) => (i as { text: string }).text)).toEqual(['one', 'two'])
    })
  })

  describe('approvals', () => {
    const q = {
      questions: [
        {
          question: 'Pick?',
          header: 'P',
          options: [
            { label: 'A', description: '' },
            { label: 'B', description: '' }
          ]
        }
      ]
    }
    const bash = (command: string) => ({ command })
    const tool = (id: string, command = 'ls'): RunEvent => ({ kind: 'toolUse', id, name: 'Bash', input: bash(command) })
    const req = (requestId: string, toolUseId: string | null, input: unknown = bash('ls'), toolName = 'Bash'): RunEvent => ({
      kind: 'permissionRequest',
      requestId,
      toolName,
      input,
      description: 'd',
      reason: 'r',
      toolUseId
    })
    const approvals = async (id: string) => (await itemsOf(id)).filter((i) => i.type === 'approval')
    const statusOf = async (id: string) => (await approvals(id)).map((i) => (i as { status: string }).status)
    const counts = () => pushes.filter((p) => p.kind === 'approvals').map((p) => (p as { pending: number }).pending)
    const hold = async (chatId: string, events: RunEvent[]) => {
      let ready!: () => void
      const emitted = new Promise<void>((resolve) => {
        ready = resolve
      })
      scripts.push({ hang: true, events, ready })
      const p = svc.send(chatId, 'go')
      await emitted // Permission answers need the actual request, regardless of disk or scheduler latency.
      return { p }
    }

    it('args use the permission mode', async () => {
      const c = await store.create('helper', dir)
      await svc.send(c.id, 'a')
      const args = calls[0].args
      expect(args[args.indexOf('--permission-mode') + 1]).toBe('auto')
      expect(args[args.indexOf('--permission-prompt-tool') + 1]).toBe('stdio')
      mode = 'manual'
      svc = makeService()
      await svc.send(c.id, 'b')
      expect(calls[1].args[calls[1].args.indexOf('--permission-mode') + 1]).toBe('manual')
    })

    it('pending card then allow once', async () => {
      const c = await store.create('helper', dir)
      const input = bash('ls -la')
      const { p } = await hold(c.id, [tool('t1', 'ls -la'), req('r1', 't1', input)])
      expect((await itemsOf(c.id)).map((i) => i.type)).toEqual(['user', 'tool', 'approval'])
      expect((await approvals(c.id))[0]).toMatchObject({ id: 'r1', status: 'pending', toolUseId: 't1' })
      expect(counts()).toEqual([1])
      expect(svc.pendingCount(c.id)).toBe(1)
      expect((await store.get(c.id))?.inFlight).toBe(true)
      svc.answer(c.id, 'r1', 'allow-once')
      expect(sent).toEqual([allowResponse('r1', input)])
      expect(svc.pendingCount(c.id)).toBe(0)
      expect(counts()).toEqual([1, 0])
      svc.stop(c.id)
      await p
      expect(await statusOf(c.id)).toEqual(['allowed-once'])
    })

    describe('risk hint', () => {
      it("puts Jev's guess on a pending card and still waits for the user", async () => {
        const asked: unknown[][] = []
        svc = makeService({
          approvalRisk: async (...a) => {
            asked.push(a)
            return 'high'
          }
        })
        const c = await store.create('helper', dir)
        const { p } = await hold(c.id, [tool('t1', 'rm -rf build'), req('r1', 't1', bash('rm -rf build'))])
        // The guess lands on the card through the chat store's file writes, which a loaded runner can stretch past a tick.
        await vi.waitFor(async () => expect((await approvals(c.id))[0]).toMatchObject({ status: 'pending', risk: 'high' }), {
          timeout: 5000
        })
        expect(asked).toEqual([[c.id, { toolName: 'Bash', input: bash('rm -rf build'), description: 'd', reason: 'r' }]])
        expect(sent).toEqual([]) // a hint, never an answer
        expect(svc.pendingCount(c.id)).toBe(1)
        svc.answer(c.id, 'r1', 'deny')
        svc.stop(c.id)
        await p
        expect((await approvals(c.id))[0]).toMatchObject({ status: 'denied', risk: 'high' })
      })

      it('adds nothing when Jev has no guess, fails, or answers after the card was answered', async () => {
        let late: (r: 'low') => void = () => {}
        // Made when asked: a rejection built up front would be unhandled until then.
        const answers = [
          () => Promise.resolve(null),
          () => Promise.reject(new Error('down')),
          () =>
            new Promise<'low'>((r) => {
              late = r
            })
        ]
        svc = makeService({ approvalRisk: () => answers.shift()!() })
        const c = await store.create('helper', dir)
        const { p } = await hold(c.id, [req('r1', null), req('r2', null, bash('pwd')), req('r3', null, bash('id'))])
        await tick()
        svc.answer(c.id, 'r3', 'allow-once')
        late('low')
        await tick()
        svc.stop(c.id)
        await p
        expect((await approvals(c.id)).map((a) => 'risk' in a)).toEqual([false, false, false])
      })

      it('asks nothing for cards answered by a rule, browser tools or questions', async () => {
        const asked = vi.fn(async () => 'low' as const)
        svc = makeService({ approvalRisk: asked })
        rules.add('helper', ruleOf('Bash', bash('ls')))
        const c = await store.create('helper', dir)
        const { p } = await hold(c.id, [
          req('r1', null),
          req('r2', null, {}, 'mcp__zumibot_browser__browser_type'),
          req('r3', null, q, 'AskUserQuestion')
        ])
        await tick()
        expect(await statusOf(c.id)).toEqual(['auto-allowed-agent', 'pending', 'pending'])
        expect(asked).not.toHaveBeenCalled()
        svc.stop(c.id)
        await p
      })
    })

    describe('connector calls', () => {
      const SEND = 'mcp__claude_ai_Gmail__send_message'
      const SEARCH = 'mcp__claude_ai_Gmail__search_threads'
      const NEW = 'mcp__claude_ai_Gmail__brand_new_tool'
      const mail = { to: 'a@b.c' }
      let remembered: Set<ConnectorId>
      beforeEach(() => {
        remembered = new Set()
        svc = makeService({
          agentRunConfig: async () => ({ ...NO_RUN_CONFIG, connectorPrefixes: connectorPrefixes([]) }),
          connectorRemembers: (id) => remembered.has(id)
        })
      })
      const sendAuto = (chatId: string) => svc.send(chatId, 'go', [], undefined, undefined, undefined, undefined, true)

      it('a read is allowed at once: no card, no item, no push, no risk hint', async () => {
        const risk = vi.fn(async () => 'low' as const)
        svc = makeService({
          agentRunConfig: async () => ({ ...NO_RUN_CONFIG, connectorPrefixes: connectorPrefixes([]) }),
          approvalRisk: risk
        })
        const c = await store.create('helper', dir)
        const { p } = await hold(c.id, [req('r1', null, mail, SEARCH)])
        expect(sent).toEqual([allowResponse('r1', mail)])
        expect(svc.pendingCount(c.id)).toBe(0)
        expect(pushes.some((x) => x.kind === 'approvals')).toBe(false)
        svc.stop(c.id)
        await p
        expect(await approvals(c.id)).toEqual([])
        expect(risk).not.toHaveBeenCalled()
      })

      it('a write in an attended turn is a pending card stamped with its connector, and Jev still guesses', async () => {
        const asked: unknown[] = []
        svc = makeService({
          agentRunConfig: async () => ({ ...NO_RUN_CONFIG, connectorPrefixes: connectorPrefixes([]) }),
          approvalRisk: async (...a) => {
            asked.push(a)
            return 'high'
          }
        })
        const c = await store.create('helper', dir)
        const { p } = await hold(c.id, [req('r1', null, mail, SEND)])
        await tick()
        expect(sent).toEqual([])
        expect((await approvals(c.id))[0]).toMatchObject({
          status: 'pending',
          connector: { id: 'gmail', tool: 'send_message', remember: false },
          risk: 'high'
        })
        expect(asked).toHaveLength(1)
        svc.stop(c.id)
        await p
      })

      it('with Remember off every allow-* is kept as allow once and stores nothing', async () => {
        const c = await store.create('helper', dir)
        const { p } = await hold(c.id, [
          req('r1', null, mail, SEND),
          req('r2', null, mail, SEND),
          req('r3', null, mail, SEND),
          req('r4', null, mail, SEND)
        ])
        svc.answer(c.id, 'r1', 'allow-agent')
        svc.answer(c.id, 'r2', 'allow-step')
        svc.answer(c.id, 'r3', 'allow-chat')
        expect(rules.added).toEqual([])
        emit(req('r5', null, mail, SEND)) // the chat key a plain tool would have left
        expect(svc.pendingCount(c.id)).toBe(2) // r4, r5
        svc.stop(c.id)
        await p
        expect(await statusOf(c.id)).toEqual(['allowed-once', 'allowed-once', 'allowed-once', 'unanswered', 'unanswered'])
        expect(rules.has('helper', ruleOf(SEND, mail).key)).toBe(false)
      })

      it('with Remember on the card says so, allow-agent is kept, and the next turn auto-allows it', async () => {
        remembered.add('gmail')
        const c = await store.create('helper', dir)
        const { p } = await hold(c.id, [req('r1', null, mail, SEND)])
        expect((await approvals(c.id))[0]).toMatchObject({
          status: 'pending',
          connector: { id: 'gmail', tool: 'send_message', remember: true }
        })
        svc.answer(c.id, 'r1', 'allow-agent')
        expect(rules.added).toEqual([['helper', ruleOf(SEND, mail)]])
        svc.stop(c.id)
        await p
        expect(await statusOf(c.id)).toEqual(['allowed-agent'])

        sent.length = 0
        const o = await store.create('helper', dir)
        const { p: p2 } = await hold(o.id, [req('r2', null, mail, SEND)])
        expect(sent).toEqual([allowResponse('r2', mail)])
        svc.stop(o.id)
        await p2
        expect(await statusOf(o.id)).toEqual(['auto-allowed-agent'])
      })

      it('a stored rule goes inert while Remember is off and is still stored', async () => {
        remembered.add('gmail')
        const a = await store.create('helper', dir)
        const { p } = await hold(a.id, [req('r1', null, mail, SEND)])
        svc.answer(a.id, 'r1', 'allow-agent')
        svc.stop(a.id)
        await p
        remembered.delete('gmail')
        sent.length = 0
        const b = await store.create('helper', dir)
        const { p: p2 } = await hold(b.id, [req('r2', null, mail, SEND)])
        expect(sent).toEqual([])
        expect(svc.pendingCount(b.id)).toBe(1)
        expect(rules.has('helper', ruleOf(SEND, mail).key)).toBe(true)
        expect((await approvals(b.id))[0]).toMatchObject({ status: 'pending', connector: { remember: false } })
        svc.stop(b.id)
        await p2
      })

      it('an earlier allow-chat key goes inert while Remember is off', async () => {
        remembered.add('gmail')
        const c = await store.create('helper', dir)
        const { p } = await hold(c.id, [req('r1', null, mail, SEND)])
        svc.answer(c.id, 'r1', 'allow-chat')
        remembered.delete('gmail')
        emit(req('r2', null, mail, SEND))
        expect(svc.pendingCount(c.id)).toBe(1)
        svc.stop(c.id)
        await p
        expect(await statusOf(c.id)).toEqual(['allowed-chat', 'unanswered'])
      })

      it('turning Remember off between card and answer keeps the answer as allow once', async () => {
        remembered.add('gmail')
        const c = await store.create('helper', dir)
        const { p } = await hold(c.id, [req('r1', null, mail, SEND)])
        remembered.delete('gmail')
        svc.answer(c.id, 'r1', 'allow-agent')
        expect(rules.added).toEqual([])
        svc.stop(c.id)
        await p
        expect(await statusOf(c.id)).toEqual(['allowed-once'])
      })

      it('an unattended turn refuses a write at once with the fixed sentence, allows a read, refuses an unknown tool', async () => {
        const risk = vi.fn(async () => 'low' as const)
        svc = makeService({
          agentRunConfig: async () => ({ ...NO_RUN_CONFIG, connectorPrefixes: connectorPrefixes([]) }),
          approvalRisk: risk
        })
        const c = await store.create('helper', dir)
        scripts.push({ hang: true, events: [req('r1', null, mail, SEND), req('r2', null, mail, SEARCH), req('r3', null, mail, NEW)] })
        const p = sendAuto(c.id)
        await vi.waitFor(() => expect(sent).toHaveLength(3))
        expect(sent).toEqual([
          denyResponse('r1', unattendedRefusal('gmail', 'send_message')),
          allowResponse('r2', mail),
          denyResponse('r3', unattendedRefusal('gmail', 'brand_new_tool'))
        ])
        expect(svc.pendingCount(c.id)).toBe(0)
        expect(pushes.some((x) => x.kind === 'approvals')).toBe(false)
        svc.stop(c.id)
        await p
        expect(await approvals(c.id)).toEqual([])
        expect(risk).not.toHaveBeenCalled()
        expect(rules.added).toEqual([])
      })

      it('a remembered rule never lets an unattended write through', async () => {
        remembered.add('gmail')
        rules.add('helper', ruleOf(SEND, mail))
        const c = await store.create('helper', dir)
        scripts.push({ hang: true, events: [req('r1', null, mail, SEND)] })
        const p = sendAuto(c.id)
        await vi.waitFor(() => expect(sent).toHaveLength(1))
        expect(sent).toEqual([denyResponse('r1', unattendedRefusal('gmail', 'send_message'))])
        svc.stop(c.id)
        await p
      })

      it('an asked turn whose asker is unattended refuses a write with the fixed sentence; an ordinary asked turn asks', async () => {
        const a = await store.create('helper', dir)
        const b = await store.create('b', dir)
        await store.update(b.id, { asked: { by: 'helper', from: a.id, fromTitle: 'Issue chat', chain: [] } })
        scripts.push({ hang: true, events: [req('r1', null, mail, SEND), req('r2', null, mail, SEARCH)] })
        const run = svc.runAsked(b.id, {
          from: 'helper',
          message: 'mail it',
          chain: ['helper'],
          parent: a.id,
          signal: new AbortController().signal,
          auto: true
        })
        await vi.waitFor(() => expect(sent).toHaveLength(2))
        expect(sent).toEqual([denyResponse('r1', unattendedRefusal('gmail', 'send_message')), allowResponse('r2', mail)])
        expect(svc.pendingCount(b.id)).toBe(0)
        svc.stop(b.id)
        await run
        sent.length = 0
        scripts.push({ hang: true, events: [req('r3', null, mail, SEND)] })
        const plain = svc.runAsked(b.id, {
          from: 'helper',
          message: 'mail it',
          chain: ['helper'],
          parent: a.id,
          signal: new AbortController().signal
        })
        await vi.waitFor(() => expect(svc.pendingCount(b.id)).toBe(1))
        expect(sent).toEqual([])
        svc.stop(b.id)
        await plain
      })

      it("the ask owner of an unattended turn is auto, and an attended turn's owner has no auto key", async () => {
        const owners: AskOwner[] = []
        svc = makeService({
          agentRunConfig: async () => ({ ...NO_RUN_CONFIG, connectorPrefixes: connectorPrefixes([]) }),
          askTurns: {
            create: (owner: AskOwner): AskTurn => {
              owners.push(owner)
              return { mcp: NO_MCP, args: [], env: {}, dispose: () => {} }
            }
          },
          askRoster: async () => []
        })
        const c = await store.create('helper', dir)
        scripts.push({ events: pong }, { events: pong })
        await svc.send(c.id, 'go', [], undefined, undefined, undefined, undefined, true)
        await svc.send(c.id, 'again')
        expect(owners).toHaveLength(2)
        expect(owners[0].auto).toBe(true)
        expect(owners[1]).not.toHaveProperty('auto')
        // The asked turn of an unattended asker passes it on down the chain.
        const b = await store.create('b', dir)
        await store.update(b.id, { asked: { by: 'helper', from: c.id, fromTitle: 'T', chain: [] } })
        scripts.push({ events: pong })
        await svc.runAsked(b.id, {
          from: 'helper',
          message: 'hi',
          chain: ['helper'],
          parent: c.id,
          signal: new AbortController().signal,
          auto: true
        })
        expect(owners[2]).toMatchObject({ chatId: b.id, chain: ['helper'], auto: true })
      })

      describe('a connector that is off for the run', () => {
        const offConfig = async () => ({
          ...NO_RUN_CONFIG,
          connectorPrefixes: connectorPrefixes([]),
          connectorsOff: ['gmail'] as ConnectorId[]
        })

        it('is denied with the Connectors-page sentence and no card, read or write, attended', async () => {
          const risk = vi.fn(async () => 'low' as const)
          svc = makeService({ agentRunConfig: offConfig, approvalRisk: risk, connectorRemembers: () => true })
          const c = await store.create('helper', dir)
          rules.add('helper', ruleOf(SEND, mail)) // even a remembered rule does not revive it
          const { p } = await hold(c.id, [req('r1', null, mail, SEARCH), req('r2', null, mail, SEND), req('r3', null, mail, NEW)])
          expect(sent).toEqual([
            denyResponse('r1', offRefusal('gmail')),
            denyResponse('r2', offRefusal('gmail')),
            denyResponse('r3', offRefusal('gmail'))
          ])
          expect(svc.pendingCount(c.id)).toBe(0)
          expect(pushes.some((x) => x.kind === 'approvals')).toBe(false)
          svc.stop(c.id)
          await p
          expect(await approvals(c.id)).toEqual([])
          expect(risk).not.toHaveBeenCalled()
        })

        it('is denied with the same sentence in an unattended turn, ahead of the read and unattended branches', async () => {
          svc = makeService({ agentRunConfig: offConfig })
          const c = await store.create('helper', dir)
          scripts.push({ hang: true, events: [req('r1', null, mail, SEARCH), req('r2', null, mail, SEND)] })
          const p = sendAuto(c.id)
          await vi.waitFor(() => expect(sent).toHaveLength(2))
          expect(sent).toEqual([denyResponse('r1', offRefusal('gmail')), denyResponse('r2', offRefusal('gmail'))])
          svc.stop(c.id)
          await p
        })

        it('leaves a connector that is on alone: its read is allowed and its write asks', async () => {
          svc = makeService({
            agentRunConfig: async () => ({
              ...NO_RUN_CONFIG,
              connectorPrefixes: connectorPrefixes([]),
              connectorsOff: ['slack'] as ConnectorId[]
            })
          })
          const c = await store.create('helper', dir)
          const { p } = await hold(c.id, [req('r1', null, mail, SEARCH), req('r2', null, mail, SEND)])
          expect(sent).toEqual([allowResponse('r1', mail)])
          expect(svc.pendingCount(c.id)).toBe(1)
          svc.stop(c.id)
          await p
        })
      })

      it('a workflow step rule that matches a write never allows it: the card stays pending', async () => {
        const c = await store.create('helper', dir)
        svc.noteWorkflowRules(c.id, [stepRuleOf(SEND, mail, 'helper')]) // the room path's own entry point
        const { p } = await hold(c.id, [req('r1', null, mail, SEND)])
        expect(sent).toEqual([])
        expect(svc.pendingCount(c.id)).toBe(1)
        expect((await approvals(c.id))[0]).toMatchObject({ status: 'pending', connector: { id: 'gmail' } })
        svc.stop(c.id)
        await p
      })

      it('allow-step on a write card with Remember on stays allow once and stores no step rule', async () => {
        remembered.add('gmail')
        const onStepRule = vi.fn()
        svc = makeService({
          agentRunConfig: async () => ({ ...NO_RUN_CONFIG, connectorPrefixes: connectorPrefixes([]) }),
          connectorRemembers: (id) => remembered.has(id),
          onStepRule
        })
        const c = await store.create('helper', dir)
        svc.noteWorkflowRules(c.id, []) // a workflow room, so allow-step would otherwise be kept
        const { p } = await hold(c.id, [req('r1', null, mail, SEND)])
        svc.answer(c.id, 'r1', 'allow-step')
        expect(onStepRule).not.toHaveBeenCalled()
        expect(rules.added).toEqual([])
        emit(req('r2', null, mail, SEND)) // no step rule made it auto-allow
        expect(svc.pendingCount(c.id)).toBe(1)
        svc.stop(c.id)
        await p
        expect(await statusOf(c.id)).toEqual(['allowed-once', 'unanswered'])
      })

      it('an attended turn asks about a tool the catalog does not list', async () => {
        const c = await store.create('helper', dir)
        const { p } = await hold(c.id, [req('r1', null, mail, NEW)])
        expect(sent).toEqual([])
        expect((await approvals(c.id))[0]).toMatchObject({
          status: 'pending',
          connector: { id: 'gmail', tool: 'brand_new_tool', remember: false }
        })
        svc.stop(c.id)
        await p
      })

      it('a write that arrives after a Stop is an unanswered card, stamped with its connector', async () => {
        const c = await store.create('helper', dir)
        let ready!: () => void
        const reached = new Promise<void>((resolve) => {
          ready = resolve
        })
        scripts.push({ hang: true, events: [], ready, onStop: [req('r1', null, mail, SEND)] })
        const p = svc.send(c.id, 'go')
        await reached
        svc.stop(c.id)
        await p
        expect((await approvals(c.id))[0]).toMatchObject({
          status: 'unanswered',
          connector: { id: 'gmail', tool: 'send_message', remember: false }
        })
        expect(sent).toEqual([])
      })

      it('any other tool takes the old path, with no connector stamp', async () => {
        const c = await store.create('helper', dir)
        const { p } = await hold(c.id, [req('r1', null, mail, 'mcp__other__do')])
        expect((await approvals(c.id))[0]).not.toHaveProperty('connector')
        svc.answer(c.id, 'r1', 'allow-agent')
        expect(rules.added).toEqual([['helper', ruleOf('mcp__other__do', mail)]])
        svc.stop(c.id)
        await p
        expect(await statusOf(c.id)).toEqual(['allowed-agent'])
      })

      it('without a prefix map (no run config) a connector-named tool is an ordinary tool', async () => {
        svc = makeService()
        const c = await store.create('helper', dir)
        const { p } = await hold(c.id, [req('r1', null, mail, SEARCH)])
        expect(svc.pendingCount(c.id)).toBe(1)
        expect((await approvals(c.id))[0]).not.toHaveProperty('connector')
        svc.stop(c.id)
        await p
      })
    })

    it('appends the card when the tool item is unknown', async () => {
      const c = await store.create('helper', dir)
      const { p } = await hold(c.id, [req('r1', 'nope')])
      expect((await itemsOf(c.id)).map((i) => i.type)).toEqual(['user', 'approval'])
      svc.stop(c.id)
      await p
    })

    it('allow for this chat auto-allows the same command', async () => {
      const c = await store.create('helper', dir)
      const other = await store.create('helper', dir)
      const { p } = await hold(c.id, [tool('t1'), req('r1', 't1')])
      svc.answer(c.id, 'r1', 'allow-chat')
      emit(req('r2', null))
      emit(req('r3', null, bash('pwd')))
      expect(sent).toEqual([allowResponse('r1', bash('ls')), allowResponse('r2', bash('ls'))])
      expect(svc.pendingCount(c.id)).toBe(1)
      svc.stop(c.id)
      await p
      expect(await statusOf(c.id)).toEqual(['allowed-chat', 'auto-allowed', 'unanswered'])

      sent.length = 0
      const { p: p2 } = await hold(c.id, [req('r4', null)])
      expect(sent).toEqual([allowResponse('r4', bash('ls'))])
      svc.stop(c.id)
      await p2

      const { p: p3 } = await hold(other.id, [req('r5', null)])
      expect(svc.pendingCount(other.id)).toBe(1)
      svc.stop(other.id)
      await p3

      svc.forget(c.id)
      const { p: p4 } = await hold(c.id, [req('r6', null)])
      expect(svc.pendingCount(c.id)).toBe(1)
      svc.stop(c.id)
      await p4
    })

    it('allow always for this agent auto-allows the same tool in another chat', async () => {
      const a = await store.create('helper', dir)
      const b = await store.create('helper', dir)
      const o = await store.create('other', dir)
      const ws = (query: string) => ({ query })
      const { p } = await hold(a.id, [req('r1', null, ws('a'), 'WebSearch')])
      svc.answer(a.id, 'r1', 'allow-agent')
      expect(sent).toEqual([allowResponse('r1', ws('a'))])
      expect(rules.added).toEqual([['helper', ruleOf('WebSearch', ws('a'))]])
      svc.stop(a.id)
      await p
      expect(await statusOf(a.id)).toEqual(['allowed-agent'])

      sent.length = 0
      const { p: p2 } = await hold(b.id, [req('r2', null, ws('b'), 'WebSearch')])
      expect(sent).toEqual([allowResponse('r2', ws('b'))])
      expect(svc.pendingCount(b.id)).toBe(0)
      svc.stop(b.id)
      await p2
      expect(await statusOf(b.id)).toEqual(['auto-allowed-agent'])

      const { p: p3 } = await hold(o.id, [req('r3', null, ws('c'), 'WebSearch')])
      expect(svc.pendingCount(o.id)).toBe(1)
      svc.stop(o.id)
      await p3
    })

    it('agent rule for Bash needs the exact command', async () => {
      const c = await store.create('helper', dir)
      const { p } = await hold(c.id, [req('r1', null, bash('ls'))])
      svc.answer(c.id, 'r1', 'allow-agent')
      emit(req('r2', null, bash('ls')))
      emit(req('r3', null, bash('ls -la')))
      expect(svc.pendingCount(c.id)).toBe(1)
      svc.stop(c.id)
      await p
      expect(await statusOf(c.id)).toEqual(['allowed-agent', 'auto-allowed-agent', 'unanswered'])
    })

    it('agent rule for Bash keeps a sandboxed and an unsandboxed call apart', async () => {
      const loose = { ...bash('ls'), dangerouslyDisableSandbox: true }
      // Remembered sandboxed: the same command without the sandbox still asks.
      const a = await store.create('helper', dir)
      const { p } = await hold(a.id, [req('r1', null, bash('ls'))])
      svc.answer(a.id, 'r1', 'allow-agent')
      emit(req('r2', null, loose))
      expect(svc.pendingCount(a.id)).toBe(1)
      svc.stop(a.id)
      await p
      expect(await statusOf(a.id)).toEqual(['allowed-agent', 'unanswered'])

      // Remembered unsandboxed: the sandboxed call still asks; the unsandboxed one is allowed.
      const b = await store.create('other', dir)
      const { p: p2 } = await hold(b.id, [req('r3', null, loose)])
      svc.answer(b.id, 'r3', 'allow-agent')
      emit(req('r4', null, bash('ls')))
      emit(req('r5', null, loose))
      expect(svc.pendingCount(b.id)).toBe(1)
      svc.stop(b.id)
      await p2
      expect(await statusOf(b.id)).toEqual(['allowed-agent', 'unanswered', 'auto-allowed-agent'])
    })

    it('chat memory is checked before agent rules', async () => {
      const c = await store.create('helper', dir)
      const { p } = await hold(c.id, [req('r1', null)])
      svc.answer(c.id, 'r1', 'allow-chat')
      rules.add('helper', ruleOf('Bash', bash('ls')))
      emit(req('r2', null))
      svc.stop(c.id)
      await p
      expect(await statusOf(c.id)).toEqual(['allowed-chat', 'auto-allowed'])
    })

    it('MCP tool allow-for-chat matches any input', async () => {
      const c = await store.create('helper', dir)
      const { p } = await hold(c.id, [req('r1', null, { a: 1 }, 'mcp__s__t')])
      svc.answer(c.id, 'r1', 'allow-chat')
      emit(req('r2', null, { b: 2 }, 'mcp__s__t'))
      expect(sent[1]).toEqual(allowResponse('r2', { b: 2 }))
      svc.stop(c.id)
      await p
      expect(await statusOf(c.id)).toEqual(['allowed-chat', 'auto-allowed'])
    })

    it('deny', async () => {
      const c = await store.create('helper', dir)
      const { p } = await hold(c.id, [tool('t1'), req('r1', 't1')])
      svc.answer(c.id, 'r1', 'deny')
      expect(sent).toEqual([denyResponse('r1', 'Denied by the user')])
      svc.stop(c.id)
      await p
      expect(await statusOf(c.id)).toEqual(['denied'])
      expect((await itemsOf(c.id)).find((i) => i.type === 'tool')).toMatchObject({ blocked: true })
    })

    it('deny: the user\'s Deny never sets blockedBy', async () => {
      const c = await store.create('helper', dir)
      const { p } = await hold(c.id, [tool('t1'), req('r1', 't1')])
      svc.answer(c.id, 'r1', 'deny')
      svc.stop(c.id)
      await p
      const t = (await itemsOf(c.id)).find((i) => i.type === 'tool')
      expect(t).toMatchObject({ blocked: true })
      expect(t).not.toHaveProperty('blockedBy')
    })

    it('stop with a pending card: later CLI refusal events do not mark the tool blocked', async () => {
      const c = await store.create('helper', dir)
      const { p } = await hold(c.id, [tool('t1'), req('r1', 't1')])
      svc.stop(c.id)
      emit({ kind: 'toolResult', toolUseId: 't1', content: APPROVAL_REQUIRED, isError: true })
      emit({ ...(okResult as object), denials: [{ toolUseId: 't1', toolName: 'Bash' }] } as RunEvent)
      await p
      const items = await itemsOf(c.id)
      expect(items.find((i) => i.type === 'tool')).toMatchObject({ id: 't1', blocked: false })
      expect(await statusOf(c.id)).toEqual(['unanswered'])
      expect(items.some((i) => i.type === 'notice' && i.kind === 'stopped')).toBe(true)
    })

    it('a CLI denial for a tool with no card still blocks it', async () => {
      const c = await store.create('helper', dir)
      const { p } = await hold(c.id, [
        tool('t1'),
        { kind: 'toolResult', toolUseId: 't1', content: APPROVAL_REQUIRED, isError: true },
        { ...(okResult as object), denials: [{ toolUseId: 't1', toolName: 'Bash' }] } as RunEvent
      ])
      svc.stop(c.id)
      await p
      expect((await itemsOf(c.id)).find((i) => i.type === 'tool')).toMatchObject({ blocked: true })
    })

    it('answer twice, unknown id and after the run ended are no-ops', async () => {
      const c = await store.create('helper', dir)
      const { p } = await hold(c.id, [req('r1', null)])
      svc.answer(c.id, 'r1', 'allow-once')
      svc.answer(c.id, 'r1', 'deny')
      svc.answer(c.id, 'nope', 'allow-once')
      svc.answer('no-chat', 'r1', 'allow-once')
      expect(sent).toHaveLength(1)
      svc.stop(c.id)
      await p
      expect(() => svc.answer(c.id, 'r1', 'allow-once')).not.toThrow()
      expect(sent).toHaveLength(1)
      expect(await statusOf(c.id)).toEqual(['allowed-once'])
    })

    it('answers in reverse order', async () => {
      const c = await store.create('helper', dir)
      const { p } = await hold(c.id, [req('r1', null, bash('a')), req('r2', null, bash('b'))])
      expect(svc.pendingCount(c.id)).toBe(2)
      svc.answer(c.id, 'r2', 'allow-once')
      svc.answer(c.id, 'r1', 'deny')
      expect(sent).toEqual([allowResponse('r2', bash('b')), denyResponse('r1', 'Denied by the user')])
      svc.stop(c.id)
      await p
      expect(await statusOf(c.id)).toEqual(['denied', 'allowed-once'])
    })

    const plan = { plan: '# Plan\n- add hello.txt', planFilePath: '/p/plan.md' }
    const planReq = (id: string, toolUseId: string | null = null, input: unknown = plan): RunEvent =>
      req(id, toolUseId, input, 'ExitPlanMode')

    it('a plan becomes a pending card', async () => {
      const c = await store.create('helper', dir)
      const { p } = await hold(c.id, [{ kind: 'toolUse', id: 't1', name: 'ExitPlanMode', input: plan }, planReq('r1', 't1')])
      expect(sent).toEqual([])
      expect(await statusOf(c.id)).toEqual(['pending'])
      expect(counts()).toEqual([1])
      svc.stop(c.id)
      await p
      expect(await statusOf(c.id)).toEqual(['unanswered'])
    })

    it('a plan is never auto-allowed by chat memory or an agent rule', async () => {
      const c = await store.create('helper', dir)
      rules.add('helper', ruleOf('ExitPlanMode', plan))
      const { p } = await hold(c.id, [planReq('r1')])
      svc.answer(c.id, 'r1', 'allow-chat') // stores no chat rule either
      emit(planReq('r2'))
      expect(sent).toHaveLength(1)
      expect(svc.pendingCount(c.id)).toBe(1)
      svc.stop(c.id)
      await p
      expect(await statusOf(c.id)).toEqual(['approved', 'unanswered'])
    })

    it('approving sends the unchanged input', async () => {
      const c = await store.create('helper', dir)
      const { p } = await hold(c.id, [planReq('r1')])
      svc.answerPlan(c.id, 'r1', true)
      expect(sent).toEqual([allowResponse('r1', plan)])
      expect(counts()[counts().length - 1]).toBe(0)
      expect(rules.added).toEqual([])
      svc.stop(c.id)
      await p
      expect(await statusOf(c.id)).toEqual(['approved'])
    })

    it("approving a plan in a Plan chat runs the rest of the turn in the server's mode, and puts the chat back on it", async () => {
      const c = await store.create('helper', dir)
      await svc.setPermissionMode(c.id, 'plan')
      const { p } = await hold(c.id, [planReq('r1')])
      expect(calls[0].args[calls[0].args.indexOf('--permission-mode') + 1]).toBe('plan')
      svc.answerPlan(c.id, 'r1', true)
      // Without setMode the CLI would go on in `default`, asking before every edit.
      expect(sent).toEqual([allowResponse('r1', plan, [{ type: 'setMode', mode: 'auto', destination: 'session' }])])
      await vi.waitFor(async () => expect((await store.get(c.id))?.permissionMode).toBeUndefined())
      svc.stop(c.id)
      await p
    })

    it('sending a plan back keeps the chat in Plan', async () => {
      const c = await store.create('helper', dir)
      await svc.setPermissionMode(c.id, 'plan')
      const { p } = await hold(c.id, [planReq('r1')])
      svc.answerPlan(c.id, 'r1', false, 'smaller')
      svc.stop(c.id)
      await p
      expect((await store.get(c.id))?.permissionMode).toBe('plan')
    })

    it('Keep planning denies with the feedback and stores it', async () => {
      const c = await store.create('helper', dir)
      const { p } = await hold(c.id, [planReq('r1')])
      svc.answerPlan(c.id, 'r1', false, '  add tests  ')
      expect(sent).toEqual([denyResponse('r1', planSentBack('add tests'))])
      svc.stop(c.id)
      await p
      expect((await approvals(c.id))[0]).toMatchObject({ status: 'sent-back', feedback: 'add tests' })
    })

    it('Keep planning without feedback stores none', async () => {
      const c = await store.create('helper', dir)
      const { p } = await hold(c.id, [planReq('r1')])
      svc.answerPlan(c.id, 'r1', false, '   ')
      expect(sent).toEqual([denyResponse('r1', planSentBack(null))])
      svc.stop(c.id)
      await p
      const [card] = await approvals(c.id)
      expect(card).toMatchObject({ status: 'sent-back' })
      expect(card).not.toHaveProperty('feedback')
    })

    it('too-long feedback throws and leaves the card pending', async () => {
      const c = await store.create('helper', dir)
      const { p } = await hold(c.id, [planReq('r1')])
      expect(() => svc.answerPlan(c.id, 'r1', false, 'x'.repeat(8193))).toThrow(TypeError)
      expect(sent).toEqual([])
      expect(await statusOf(c.id)).toEqual(['pending'])
      svc.stop(c.id)
      await p
    })

    it('answerPlan on a non-plan pending request is a no-op', async () => {
      const c = await store.create('helper', dir)
      const { p } = await hold(c.id, [tool('t1'), req('r1', 't1')])
      svc.answerPlan(c.id, 'r1', true)
      svc.answerPlan(c.id, 'r1', false, 'x')
      expect(sent).toEqual([])
      expect(await statusOf(c.id)).toEqual(['pending'])
      svc.stop(c.id)
      await p
    })

    it('chats:answer on a plan: allow-* approve once and save no rule, deny sends it back', async () => {
      const c = await store.create('helper', dir)
      const { p } = await hold(c.id, [planReq('r1'), planReq('r2'), planReq('r3')])
      svc.answer(c.id, 'r1', 'allow-agent')
      svc.answer(c.id, 'r2', 'allow-once')
      svc.answer(c.id, 'r3', 'deny')
      expect(sent).toEqual([allowResponse('r1', plan), allowResponse('r2', plan), denyResponse('r3', planSentBack(null))])
      expect(rules.added).toEqual([])
      svc.stop(c.id)
      await p
      expect(await statusOf(c.id)).toEqual(['approved', 'approved', 'sent-back'])
    })

    it('answering a plan twice or after Stop is harmless', async () => {
      const c = await store.create('helper', dir)
      const { p } = await hold(c.id, [planReq('r1')])
      svc.answerPlan(c.id, 'r1', true)
      svc.answerPlan(c.id, 'r1', false, 'late')
      expect(sent).toHaveLength(1)
      svc.stop(c.id)
      await p
      const c2 = await store.create('helper', dir)
      const { p: p2 } = await hold(c2.id, [planReq('r2')])
      svc.stop(c2.id)
      await p2
      expect(() => svc.answerPlan(c2.id, 'r2', true)).not.toThrow()
      expect(await statusOf(c2.id)).toEqual(['unanswered'])
    })

    it('a plan card has no Jev risk hint', async () => {
      const approvalRisk = vi.fn(async () => 'high' as const)
      const s2 = makeService({ approvalRisk })
      const c = await store.create('helper', dir)
      scripts.push({ hang: true, events: [planReq('r1')] })
      const p = s2.send(c.id, 'go')
      await tick()
      expect(approvalRisk).not.toHaveBeenCalled()
      s2.stop(c.id)
      await p
    })

    it('onAnswered runs on approve and on Keep planning', async () => {
      const c = await store.create('helper', dir)
      let items: ChatItem[] = []
      const ref = {
        get: () => items,
        set: (next: ChatItem[]) => {
          items = next
        }
      }
      const onAnswered = vi.fn()
      const r = svc.claim(c.id)
      scripts.push({ hang: true, events: [planReq('r1')] })
      const done = svc.agentTurn(
        c.id,
        r,
        {
          agentName: 'helper',
          sessionId: null,
          prompt: 'go',
          seedPrompt: () => 'go',
          extraArgs: [],
          disallowedTools: [],
          allowScope: c.id,
          saveSession: async () => {},
          onAnswered
        },
        ref
      )
      await tick()
      svc.answerPlan(c.id, 'r1', true)
      expect(onAnswered).toHaveBeenCalledTimes(1)
      emit(planReq('r2'))
      svc.answerPlan(c.id, 'r2', false, 'more')
      expect(onAnswered).toHaveBeenCalledTimes(2)
      svc.stop(c.id)
      await done
      svc.release(c.id, r)
    })

    it('a question becomes a pending card', async () => {
      const c = await store.create('helper', dir)
      const { p } = await hold(c.id, [req('r1', null, q, 'AskUserQuestion')])
      expect(sent).toEqual([])
      expect(await statusOf(c.id)).toEqual(['pending'])
      expect(counts()).toEqual([1])
      svc.stop(c.id)
      await p
    })

    it("a task card's chat gets no question card: the agent is told to put it on the card", async () => {
      const c = await store.create('helper', dir, { task: { todoId: 'card1' } })
      const { p } = await hold(c.id, [req('r1', null, q, 'AskUserQuestion')])
      await vi.waitFor(() => expect(sent).toEqual([denyResponse('r1', TASK_QUESTIONS_DENIED)]))
      expect(await statusOf(c.id)).toEqual([])
      svc.stop(c.id)
      await p
    })

    it('a question is never auto-allowed', async () => {
      const c = await store.create('helper', dir)
      rules.add('helper', ruleOf('AskUserQuestion', q))
      const { p } = await hold(c.id, [req('r1', null, q, 'AskUserQuestion')])
      expect(await statusOf(c.id)).toEqual(['pending'])
      expect(sent).toEqual([])
      svc.stop(c.id)
      await p
    })

    it('answering sends the answers', async () => {
      const c = await store.create('helper', dir)
      const { p } = await hold(c.id, [req('r1', null, q, 'AskUserQuestion')])
      svc.answerQuestions(c.id, 'r1', { 'Pick?': 'B' })
      expect(sent).toEqual([allowResponse('r1', { ...q, answers: { 'Pick?': 'B' } })])
      svc.stop(c.id)
      await p
      expect((await approvals(c.id))[0]).toMatchObject({ status: 'answered', answers: { 'Pick?': 'B' } })
      expect(counts()[counts().length - 1]).toBe(0)
    })

    it('Skip denies the questions', async () => {
      const c = await store.create('helper', dir)
      const { p } = await hold(c.id, [req('r1', null, q, 'AskUserQuestion')])
      svc.answerQuestions(c.id, 'r1', null)
      expect(sent).toEqual([denyResponse('r1', SKIPPED_BY_USER)])
      svc.stop(c.id)
      await p
      expect(await statusOf(c.id)).toEqual(['skipped'])
    })

    it('bad answers throw and leave the card pending', async () => {
      const c = await store.create('helper', dir)
      const { p } = await hold(c.id, [req('r1', null, q, 'AskUserQuestion')])
      expect(() => svc.answerQuestions(c.id, 'r1', { 'Pick?': ' ' })).toThrow(TypeError)
      expect(sent).toEqual([])
      expect(await statusOf(c.id)).toEqual(['pending'])
      svc.stop(c.id)
      await p
    })

    it('answerQuestions on a non-question pending request is a no-op', async () => {
      const c = await store.create('helper', dir)
      const input = bash('ls -la')
      const { p } = await hold(c.id, [tool('t1', 'ls -la'), req('r1', 't1', input)])
      expect(() => svc.answerQuestions(c.id, 'r1', { 'Pick?': 'A' })).not.toThrow()
      expect(sent).toEqual([])
      expect(await statusOf(c.id)).toEqual(['pending'])
      expect(() => svc.answerQuestions(c.id, 'r1', null)).not.toThrow()
      expect(sent).toEqual([])
      expect(await statusOf(c.id)).toEqual(['pending'])
      svc.stop(c.id)
      await p
    })

    it('chats:answer on a question card: deny skips, allow is ignored', async () => {
      const c = await store.create('helper', dir)
      const { p } = await hold(c.id, [req('r1', null, q, 'AskUserQuestion')])
      svc.answer(c.id, 'r1', 'allow-once')
      expect(sent).toEqual([])
      expect(await statusOf(c.id)).toEqual(['pending'])
      svc.answer(c.id, 'r1', 'deny')
      expect(sent).toEqual([denyResponse('r1', SKIPPED_BY_USER)])
      svc.stop(c.id)
      await p
      expect(await statusOf(c.id)).toEqual(['skipped'])
    })

    it('answering twice or after Stop is harmless', async () => {
      const c = await store.create('helper', dir)
      const { p } = await hold(c.id, [req('r1', null, q, 'AskUserQuestion')])
      svc.answerQuestions(c.id, 'r1', { 'Pick?': 'A' })
      svc.answerQuestions(c.id, 'r1', { 'Pick?': 'B' })
      expect(sent).toHaveLength(1)
      svc.stop(c.id)
      await p

      const c2 = await store.create('helper', dir)
      const { p: p2 } = await hold(c2.id, [req('r2', null, q, 'AskUserQuestion')])
      svc.stop(c2.id)
      await p2
      expect(() => svc.answerQuestions(c2.id, 'r2', { 'Pick?': 'A' })).not.toThrow()
      expect(await statusOf(c2.id)).toEqual(['unanswered'])
    })

    it('onAnswered runs on answer, not on Skip', async () => {
      const c = await store.create('helper', dir)
      let items: ChatItem[] = []
      const ref = {
        get: () => items,
        set: (next: ChatItem[]) => {
          items = next
        }
      }
      const onAnswered = vi.fn()
      const r = svc.claim(c.id)
      scripts.push({
        hang: true,
        events: [{ kind: 'toolUse', id: 't1', name: 'AskUserQuestion', input: q }, req('r1', 't1', q, 'AskUserQuestion')]
      })
      const done = svc.agentTurn(
        c.id,
        r,
        {
          agentName: 'helper',
          sessionId: null,
          prompt: 'go',
          seedPrompt: () => 'go',
          extraArgs: [],
          disallowedTools: [],
          allowScope: c.id,
          saveSession: async () => {},
          onAnswered
        },
        ref
      )
      await tick()
      svc.answerQuestions(c.id, 'r1', { 'Pick?': 'A' })
      expect(onAnswered).toHaveBeenCalledTimes(1)
      emit({ kind: 'toolUse', id: 't2', name: 'AskUserQuestion', input: q })
      emit(req('r2', 't2', q, 'AskUserQuestion'))
      svc.answerQuestions(c.id, 'r2', null)
      expect(onAnswered).toHaveBeenCalledTimes(1)
      svc.stop(c.id)
      await done
      svc.release(c.id, r)
    })

    it('unknown request kind gets an error reply', async () => {
      const c = await store.create('helper', dir)
      const { p } = await hold(c.id, [
        { kind: 'controlUnknown', requestId: 'q1', subtype: 'hook_callback' },
        { kind: 'controlUnknown', requestId: null, subtype: '' }
      ])
      expect(sent).toEqual([errorResponse('q1', 'ZumiBot does not handle this request')])
      svc.stop(c.id)
      await p
      const errs = (await itemsOf(c.id)).filter((i) => i.type === 'error').map((i) => (i as { text: string }).text)
      expect(errs).toEqual([
        'The CLI sent a request ZumiBot does not handle (hook_callback).',
        'The CLI sent a request ZumiBot does not handle (unknown).'
      ])
    })

    it('withdrawn request', async () => {
      const c = await store.create('helper', dir)
      const { p } = await hold(c.id, [req('r1', null), { kind: 'permissionCancel', requestId: 'r1' }])
      expect(await statusOf(c.id)).toEqual(['unanswered'])
      expect(sent).toEqual([])
      expect(counts()).toEqual([1, 0])
      svc.answer(c.id, 'r1', 'allow-once')
      expect(sent).toEqual([])
      svc.stop(c.id)
      await p
    })

    it('a send that fails leaves the card unanswered', async () => {
      const c = await store.create('helper', dir)
      const { p } = await hold(c.id, [req('r1', null), req('r2', null, bash('b'))])
      sendOk = false
      svc.answer(c.id, 'r1', 'allow-chat')
      emit(req('r3', null, bash('a')))
      svc.stop(c.id)
      await p
      expect(await statusOf(c.id)).toEqual(['unanswered', 'unanswered', 'unanswered'])
    })

    it('a request arriving after Stop is recorded unanswered with no live card', async () => {
      const c = await store.create('helper', dir)
      const { p } = await hold(c.id, [tool('t1')])
      svc.stop(c.id)
      emit(req('r1', 't1'))
      await p
      const items = await itemsOf(c.id)
      expect(await statusOf(c.id)).toEqual(['unanswered'])
      expect(items.map((i) => i.type)).toEqual(['user', 'tool', 'approval', 'notice'])
      expect(counts().includes(1)).toBe(false)
      expect(svc.pendingCount(c.id)).toBe(0)
      expect(sent).toEqual([])
      expect(items[items.length - 1]).toMatchObject({ type: 'notice', kind: 'stopped' })
    })

    it('auto-allowed card lands right after its own tool row', async () => {
      const c = await store.create('helper', dir)
      const { p } = await hold(c.id, [tool('t1', 'a'), req('r1', 't1', bash('a'))])
      svc.answer(c.id, 'r1', 'allow-chat')
      emit(tool('t2', 'b'))
      emit(tool('t3', 'a'))
      emit(req('r3', 't3', bash('a')))
      emit(req('r4', 't1', bash('a')))
      svc.stop(c.id)
      await p
      const items = await itemsOf(c.id)
      expect(items.map((i) => (i.type === 'tool' || i.type === 'approval' ? i.id : i.type))).toEqual([
        'user',
        't1',
        'r4',
        'r1',
        't2',
        't3',
        'r3',
        'notice'
      ])
      expect(await statusOf(c.id)).toEqual(['auto-allowed', 'allowed-chat', 'auto-allowed'])
    })

    it('a duplicate request id adds no second card and sends nothing twice', async () => {
      const c = await store.create('helper', dir)
      const { p } = await hold(c.id, [tool('t1'), req('r1', 't1')])
      emit(req('r1', 't1'))
      expect(await approvals(c.id)).toHaveLength(1)
      expect(svc.pendingCount(c.id)).toBe(1)
      svc.answer(c.id, 'r1', 'allow-once')
      emit(req('r1', 't1'))
      expect(await approvals(c.id)).toHaveLength(1)
      expect(sent).toHaveLength(1)
      svc.stop(c.id)
      await p
    })

    it('stop with a pending card', async () => {
      const c = await store.create('helper', dir)
      const { p } = await hold(c.id, [tool('t1'), req('r1', 't1')])
      svc.stop(c.id)
      await p
      const items = await itemsOf(c.id)
      expect(await statusOf(c.id)).toEqual(['unanswered'])
      expect(items[items.length - 1]).toMatchObject({ type: 'notice', kind: 'stopped' })
      expect((await store.get(c.id))?.inFlight).toBe(false)
      expect(svc.pendingCount(c.id)).toBe(0)
      expect(counts()[counts().length - 1]).toBe(0)
    })

    it('stopAll with pending cards', async () => {
      const a = await store.create('helper', dir)
      const b = await store.create('helper', dir)
      scripts.push({ hang: true, events: [req('r1', null)] }, { hang: true, events: [req('r2', null)] })
      const pa = svc.send(a.id, 'one')
      const pb = svc.send(b.id, 'two')
      // Both cards must be up before stopAll, or there is nothing to mark unanswered.
      await vi.waitFor(() => expect([svc.pendingCount(a.id), svc.pendingCount(b.id)]).toEqual([1, 1]), { timeout: 5000 })
      expect(svc.runningCount()).toBe(2)
      await svc.stopAll()
      await Promise.all([pa, pb])
      expect(svc.runningCount()).toBe(0)
      for (const id of [a.id, b.id]) {
        const items = await itemsOf(id)
        expect(await statusOf(id)).toEqual(['unanswered'])
        expect(items[items.length - 1]).toMatchObject({ type: 'notice', kind: 'interrupted' })
        expect((await store.get(id))?.inFlight).toBe(false)
      }
    })

    it('delete while pending', async () => {
      const c = await store.create('helper', dir)
      const { p } = await hold(c.id, [req('r1', null)])
      await store.remove(c.id)
      svc.stop(c.id)
      await expect(p).resolves.toBeUndefined()
      expect(svc.pendingCount(c.id)).toBe(0)
      expect(svc.runningCount()).toBe(0)
      await expect(fs.access(join(dir, 'chats', `${c.id}.json`))).rejects.toThrow()
    })

    it('process ends while pending', async () => {
      const c = await store.create('helper', dir)
      scripts.push({ events: [req('r1', null)], outcome: { exitCode: 1, stderr: 'boom', result: null } })
      await svc.send(c.id, 'go')
      const items = await itemsOf(c.id)
      expect(await statusOf(c.id)).toEqual(['unanswered'])
      expect(items[items.length - 1]).toMatchObject({ type: 'error', text: 'boom' })
      expect(counts()).toEqual([1, 0])
      expect((await store.get(c.id))?.inFlight).toBe(false)
    })

    it('a card pending in the first attempt of an expired fallback ends unanswered', async () => {
      const c = await store.create('helper', dir)
      await store.update(c.id, { sessionId: 'old' })
      scripts.push({
        events: [req('r1', null)],
        outcome: { exitCode: 1, stderr: 'No conversation found with session ID: old', result: null }
      })
      scripts.push({ events: [{ kind: 'assistantText', text: 'pong' }, okResult] })
      await svc.send(c.id, 'ping')
      expect(calls).toHaveLength(2)
      expect(await statusOf(c.id)).toEqual(['unanswered'])
      expect(svc.pendingCount(c.id)).toBe(0)
    })
  })
})

describe('agentTurn', () => {
  type TurnSpec = Parameters<ChatService['agentTurn']>[2]
  type ItemsRef = Parameters<ChatService['agentTurn']>[3]
  const memRef = (start: ChatItem[] = []): ItemsRef => {
    let items = start
    return {
      get: () => items,
      set: (next) => {
        items = next
      }
    }
  }
  const spec = (o: Partial<TurnSpec> = {}): TurnSpec => ({
    agentName: 'helper',
    sessionId: null,
    prompt: 'go',
    seedPrompt: () => 'seed',
    extraArgs: [],
    disallowedTools: [],
    allowScope: 'scope',
    saveSession: async () => {},
    ...o
  })
  const shape = (items: ChatItem[]) => items.map((i) => (i.type === 'notice' ? `notice:${i.kind}` : i.type))

  it('stamps the author', async () => {
    const c = await store.create('helper', dir)
    scripts.push({
      events: [
        { kind: 'init', sessionId: 's1' },
        { kind: 'toolUse', id: 't1', name: 'AskUserQuestion', input: {} },
        {
          kind: 'permissionRequest',
          requestId: 'r1',
          toolName: 'AskUserQuestion',
          input: {},
          description: 'd',
          reason: 'r',
          toolUseId: 't1'
        },
        { kind: 'textDelta', text: 'pong' },
        { kind: 'assistantText', text: 'pong' },
        okResult
      ]
    })
    const r = svc.claim(c.id)
    const ref = memRef()
    const res = await svc.agentTurn(c.id, r, spec({ author: 'a' }), ref)
    svc.release(c.id, r)
    expect(res).toEqual({ text: 'pong', ok: true, stopped: false, end: null })
    expect(ref.get().map((i) => [i.type, 'agent' in i ? i.agent : null])).toEqual([
      ['tool', 'a'],
      ['approval', 'a'],
      ['assistant', 'a']
    ])
    expect(await itemsOf(c.id)).toEqual(ref.get())
    expect(svc.isRunning(c.id)).toBe(false)
  })

  it('send writes no author on single-chat items', async () => {
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'ping')
    expect((await itemsOf(c.id)).some((i) => 'agent' in i)).toBe(false)
  })

  it('runs the spec agent, session, prompt and args, saves the session and leaves the meta alone', async () => {
    const c = await store.create('helper', dir)
    const saved: (string | null)[] = []
    const r = svc.claim(c.id)
    await svc.agentTurn(
      c.id,
      r,
      spec({
        agentName: 'ui',
        sessionId: 'old',
        prompt: 'hi',
        extraArgs: ['--x', '1'],
        disallowedTools: ['Agent(wk)'],
        saveSession: async (id) => {
          saved.push(id)
        }
      }),
      memRef()
    )
    svc.release(c.id, r)
    expect(calls[0].args.slice(0, 5)).toEqual(['-p', '--agent', 'ui', '--resume', 'old'])
    expect(calls[0].args.slice(-4)).toEqual(['--x', '1', '--disallowedTools', 'Agent(wk)'])
    expect(calls[0].stdin).toBe('hi')
    expect(calls[0].cwd).toBe(dir)
    expect(saved).toEqual(['s1'])
    expect(await store.get(c.id)).toMatchObject({ sessionId: null, inFlight: false, title: '' })
  })

  it('keeps items added to the ref mid-turn', async () => {
    const c = await store.create('helper', dir)
    const up = hangUntilReady([{ kind: 'assistantText', text: 'one' }])
    const r = svc.claim(c.id)
    const ref = memRef()
    const p = svc.agentTurn(c.id, r, spec(), ref)
    await up
    await tick()
    const userItem: ChatItem = { type: 'user', id: 'u-mid', text: 'also this', ts: 5 }
    ref.set([...ref.get(), userItem])
    emit({ kind: 'assistantText', text: 'two' })
    svc.stop(c.id)
    const res = await p
    svc.release(c.id, r)
    const saved = await itemsOf(c.id)
    expect(saved).toContainEqual(userItem)
    expect(shape(saved)).toEqual(['assistant', 'user', 'assistant', 'notice:stopped'])
    expect(res).toEqual({ text: 'one\n\ntwo', ok: false, stopped: true, end: null })
  })

  it('a queued save writes the items current when it runs, not a stale snapshot', async () => {
    const c = await store.create('helper', dir)
    let unblock: () => void = () => {}
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve
    })
    // init queues a session save that blocks; the assistant text's save queues behind it
    const up = hangUntilReady([
        { kind: 'init', sessionId: 's1' },
        { kind: 'assistantText', text: 'one' }
    ])
    const r = svc.claim(c.id)
    const ref = memRef()
    const p = svc.agentTurn(c.id, r, spec({ saveSession: () => blocked }), ref)
    await up
    await tick()
    const userItem: ChatItem = { type: 'user', id: 'u-mid', text: 'also this', ts: 5 }
    ref.set([...ref.get(), userItem])
    await store.saveItems(c.id, [...ref.get()])
    unblock()
    await tick()
    expect(await itemsOf(c.id)).toContainEqual(userItem)
    svc.stop(c.id)
    await p
    svc.release(c.id, r)
  })

  it("text holds only this turn's assistant text", async () => {
    const c = await store.create('helper', dir)
    scripts.push({ events: [{ kind: 'assistantText', text: 'one' }, { kind: 'textDelta', text: 'two' }, okResult] })
    const r = svc.claim(c.id)
    const res = await svc.agentTurn(c.id, r, spec(), memRef([{ type: 'assistant', id: 'a0', text: 'old', ts: 1 }]))
    svc.release(c.id, r)
    expect(res.text).toBe('one\n\ntwo')
  })

  it('allow-for-chat memory is per scope', async () => {
    const c = await store.create('helper', dir)
    const input = { command: 'ls' }
    const turnIn = async (scope: string, requestId: string, act?: () => void) => {
      const up = hangUntilReady([{ kind: 'permissionRequest', requestId, toolName: 'Bash', input, description: 'd', reason: 'r', toolUseId: null }])
      const r = svc.claim(c.id)
      const p = svc.agentTurn(c.id, r, spec({ allowScope: scope }), memRef())
      await up
      await tick()
      const pending = svc.pendingCount(c.id)
      act?.()
      svc.stop(c.id)
      await p
      svc.release(c.id, r)
      return pending
    }
    expect(await turnIn(`${c.id}:a`, 'r1', () => svc.answer(c.id, 'r1', 'allow-chat'))).toBe(1)
    sent.length = 0
    expect(await turnIn(`${c.id}:b`, 'r2')).toBe(1)
    expect(sent).toEqual([])
    expect(await turnIn(`${c.id}:a`, 'r3')).toBe(0)
    expect(sent).toEqual([allowResponse('r3', input)])
    svc.forget(c.id)
    expect(await turnIn(`${c.id}:a`, 'r4')).toBe(1)
  })

  it("copyAllowed hands one scope's allow-for-chat memory to another", async () => {
    const c = await store.create('helper', dir)
    const input = { command: 'ls' }
    const turnIn = async (scope: string, requestId: string, act?: () => void) => {
      const up = hangUntilReady([{ kind: 'permissionRequest', requestId, toolName: 'Bash', input, description: 'd', reason: 'r', toolUseId: null }])
      const r = svc.claim(c.id)
      const p = svc.agentTurn(c.id, r, spec({ allowScope: scope }), memRef())
      await up
      await tick()
      const pending = svc.pendingCount(c.id)
      act?.()
      svc.stop(c.id)
      await p
      svc.release(c.id, r)
      return pending
    }
    expect(await turnIn('a:writer', 'r1', () => svc.answer(c.id, 'r1', 'allow-chat'))).toBe(1)
    svc.copyAllowed('a:writer', 'b:writer')
    svc.copyAllowed('a:nobody', 'b:nobody') // nothing to copy: no-op
    sent.length = 0
    expect(await turnIn('b:writer', 'r2')).toBe(0)
    expect(sent).toEqual([allowResponse('r2', input)])
    expect(await turnIn('b:nobody', 'r3')).toBe(1)
    // the copy is its own set: forgetting the source leaves it
    svc.forget('a')
    sent.length = 0
    expect(await turnIn('b:writer', 'r4')).toBe(0)
    expect(sent).toEqual([allowResponse('r4', input)])
    expect(await turnIn('a:writer', 'r5')).toBe(1)
  })

  it('reports failure', async () => {
    const c = await store.create('helper', dir)
    scripts.push({ outcome: { exitCode: 1, result: null } })
    const r = svc.claim(c.id)
    const ref = memRef()
    const res = await svc.agentTurn(c.id, r, spec(), ref)
    svc.release(c.id, r)
    expect(res).toEqual({ text: '', ok: false, stopped: false, end: null })
    expect(ref.get()).toEqual([expect.objectContaining({ type: 'error', text: 'Claude exited with code 1' })])
  })

  it('reseeds an expired session from the history it started with', async () => {
    const c = await store.create('helper', dir)
    const prior: ChatItem[] = [{ type: 'user', id: 'u0', text: 'hello', ts: 1 }]
    scripts.push({ outcome: { exitCode: 1, stderr: 'No conversation found with session ID: old', result: null } })
    scripts.push({ events: [{ kind: 'init', sessionId: 'new' }, { kind: 'assistantText', text: 'pong' }, okResult] })
    const saved: (string | null)[] = []
    const histories: ChatItem[][] = []
    const r = svc.claim(c.id)
    const ref = memRef(prior)
    const res = await svc.agentTurn(
      c.id,
      r,
      spec({
        sessionId: 'old',
        seedPrompt: (h) => {
          histories.push(h)
          return 'seeded'
        },
        saveSession: async (id) => {
          saved.push(id)
        }
      }),
      ref
    )
    svc.release(c.id, r)
    expect(calls).toHaveLength(2)
    expect(calls[1].args).not.toContain('--resume')
    expect(calls[1].stdin).toBe('seeded')
    expect(histories).toEqual([prior])
    expect(saved).toEqual([null, 'new'])
    expect(shape(ref.get())).toEqual(['user', 'notice:expired', 'assistant'])
    expect(res).toEqual({ text: 'pong', ok: true, stopped: false, end: null })
  })

  it('stop calls onStop', async () => {
    const c = await store.create('helper', dir)
    const r = svc.claim(c.id)
    r.onStop = vi.fn()
    svc.stop(c.id)
    expect(r.onStop).toHaveBeenCalledTimes(1)
    expect(r.reason).toBe('stopped')
    svc.release(c.id, r)
    expect(svc.isRunning(c.id)).toBe(false)
  })

  it('claim refuses a running chat and release frees only its own claim', async () => {
    const r = svc.claim('c1')
    expect(() => svc.claim('c1')).toThrow('Chat is already running')
    await expect(svc.send('c1', 'x')).rejects.toThrow('Chat is already running')
    svc.release('c1', { ...r })
    expect(svc.isRunning('c1')).toBe(true)
    svc.release('c1', r)
    expect(svc.isRunning('c1')).toBe(false)
  })
})

describe('agentTurn side by side', () => {
  type TurnSpec = Parameters<ChatService['agentTurn']>[2]
  type ItemsRef = Parameters<ChatService['agentTurn']>[3]
  const memRef = (): ItemsRef => {
    let items: ChatItem[] = []
    return {
      get: () => items,
      set: (next) => {
        items = next
      }
    }
  }
  const spec = (o: Partial<TurnSpec> = {}): TurnSpec => ({
    agentName: 'helper',
    sessionId: null,
    prompt: 'go',
    seedPrompt: () => 'seed',
    extraArgs: [],
    disallowedTools: [],
    allowScope: 'scope',
    saveSession: async () => {},
    ...o
  })
  const agentOf = (o: RunOptions) => o.args[o.args.indexOf('--agent') + 1]
  // Each run has its own event channel; the shared `emit` only reaches the latest one.
  const emitTo = (agent: string) => calls.find((o) => agentOf(o) === agent)!.onEvent
  const req = (requestId: string, input: unknown): RunEvent => ({
    kind: 'permissionRequest',
    requestId,
    toolName: 'Bash',
    input,
    description: 'd',
    reason: 'r',
    toolUseId: null
  })
  const counts = () => pushes.filter((p) => p.kind === 'approvals').map((p) => p.pending)

  // Claims the chat once, then starts a hanging turn for `ui` and one for `wk` on that claim.
  const startBoth = async () => {
    const c = await store.create('helper', dir)
    const r = svc.claim(c.id)
    const ref = memRef()
    let ended = 0
    const ups: Promise<void>[] = []
    const turns = ['ui', 'wk'].map((agent) => {
      ups.push(hangUntilReady())
      const p = svc.agentTurn(c.id, r, spec({ agentName: agent, author: agent, allowScope: `${c.id}:${agent}`, turnId: `T-${agent}` }), ref)
      p.then(
        () => {
          ended++
        },
        () => {
          ended++
        }
      )
      return p
    })
    await Promise.all(ups)
    await tick()
    return { c, r, ref, turns, ended: () => ended }
  }

  it('two turns on one claim run side by side and stop together', async () => {
    const { c, r, ref, turns, ended } = await startBoth()
    expect(calls.map(agentOf).sort()).toEqual(['ui', 'wk'])
    expect(ended()).toBe(0)
    svc.stop(c.id)
    const results = await Promise.all(turns)
    svc.release(c.id, r)
    expect(results.map((x) => x.stopped)).toEqual([true, true])
    const notices = ref.get().filter((i) => i.type === 'notice')
    expect(notices.map((i) => [i.kind, i.turn]).sort()).toEqual([
      ['stopped', 'T-ui'],
      ['stopped', 'T-wk']
    ])
  })

  it('routes an answer to the asking agent when request ids repeat', async () => {
    const { c, r, ref, turns } = await startBoth()
    emitTo('ui')(req('r1', { command: 'ui' }))
    emitTo('wk')(req('r1', { command: 'wk' }))
    expect(svc.pendingCount(c.id)).toBe(2)
    svc.answer(c.id, 'r1', 'allow-once', 'wk')
    expect(sent).toEqual([allowResponse('r1', { command: 'wk' })])
    expect(sentVia.map(agentOf)).toEqual(['wk'])
    const cards = () =>
      ref
        .get()
        .filter((i) => i.type === 'approval')
        .map((i) => [i.agent, i.status])
    expect(cards()).toEqual([
      ['ui', 'pending'],
      ['wk', 'allowed-once']
    ])
    expect(svc.pendingCount(c.id)).toBe(1)
    expect(counts()).toEqual([1, 2, 1])
    svc.answer(c.id, 'r1', 'allow-once', 'ui')
    expect(sentVia.map(agentOf)).toEqual(['wk', 'ui'])
    expect(cards()).toEqual([
      ['ui', 'allowed-once'],
      ['wk', 'allowed-once']
    ])
    expect(svc.pendingCount(c.id)).toBe(0)
    svc.stop(c.id)
    await Promise.all(turns)
    svc.release(c.id, r)
  })

  it('stamps a turn id on every item the turn adds', async () => {
    const itemsOfTurn = async (o: Partial<TurnSpec>) => {
      const c = await store.create('helper', dir)
      const up = hangUntilReady([
          { kind: 'toolUse', id: 't1', name: 'Bash', input: {} },
          req('r1', {}),
          { kind: 'assistantText', text: 'hi' },
          { kind: 'controlUnknown', requestId: null, subtype: 'x' }
      ])
      const r = svc.claim(c.id)
      const ref = memRef()
      const p = svc.agentTurn(c.id, r, spec(o), ref)
      await up
      await tick()
      svc.stop(c.id)
      await p
      svc.release(c.id, r)
      return ref.get()
    }
    const stamped = await itemsOfTurn({ author: 'ui', turnId: 'T' })
    expect(stamped.map((i) => [i.type, 'turn' in i ? i.turn : 'none'])).toEqual([
      ['tool', 'T'],
      ['approval', 'T'],
      ['assistant', 'T'],
      ['error', 'T'],
      ['notice', 'T']
    ])
    const plain = await itemsOfTurn({})
    expect(plain.map((i) => i.type)).toEqual(['tool', 'approval', 'assistant', 'error', 'notice'])
    expect(plain.some((i) => 'turn' in i)).toBe(false)
  })

  it("scopes delta and items pushes to the turn's author", async () => {
    const c = await store.create('helper', dir)
    const r = svc.claim(c.id)
    await svc.agentTurn(c.id, r, spec({ author: 'ui' }), memRef())
    svc.release(c.id, r)
    const live = () => pushes.filter((p) => p.kind === 'delta' || p.kind === 'items')
    expect(live().map((p) => p.kind)).toEqual(['delta', 'delta', 'items', 'items', 'items'])
    expect(live().every((p) => p.agent === 'ui')).toBe(true)
    pushes.length = 0
    await svc.send(c.id, 'ping')
    expect(live().length).toBeGreaterThan(2)
    expect(live().some((p) => 'agent' in p)).toBe(false)
  })

  describe('attachments', () => {
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
    const img: Attachment = { id: 'a1', name: 'pic.png', mime: 'image/png', size: PNG.length, kind: 'image' }
    const txt: Attachment = { id: 'a2', name: 'note.txt', mime: 'text/plain', size: 5, kind: 'file' }
    const write = async (chatId: string, atts: Attachment[]) => {
      for (const a of atts) {
        await fs.mkdir(join(files.dirOf(chatId), a.id), { recursive: true })
        await fs.writeFile(files.pathOf(chatId, a), a.kind === 'image' ? PNG : 'hello')
      }
    }
    const imageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } }

    it('records attachments on the user item and sends image blocks', async () => {
      const c = await store.create('helper', dir)
      await write(c.id, [img, txt])
      await svc.send(c.id, 'what is this', [img, txt])
      const user = (await itemsOf(c.id))[0]
      expect(user).toMatchObject({ type: 'user', text: 'what is this', attachments: [img, txt] })
      const refs = refsOf([img, txt], (a) => files.pathOf(c.id, a))
      expect(calls[0].stdin).toEqual([{ type: 'text', text: withNote('what is this', refs) }, imageBlock])
      const i = calls[0].args.indexOf('--add-dir')
      expect(i).toBeGreaterThan(-1)
      expect(calls[0].args[i + 1]).toBe(files.dirOf(c.id))
    })

    it('keeps a plain string prompt and no --add-dir without attachments', async () => {
      const c = await store.create('helper', dir)
      await svc.send(c.id, 'ping')
      expect(calls[0].stdin).toBe('ping')
      expect(calls[0].args).not.toContain('--add-dir')
      expect('attachments' in (await itemsOf(c.id))[0]).toBe(false)
    })

    it('later turns keep --add-dir once a message had attachments', async () => {
      const c = await store.create('helper', dir)
      await write(c.id, [txt])
      await svc.send(c.id, 'see', [txt])
      await svc.send(c.id, 'and then')
      expect(calls[1].args).toContain('--add-dir')
      expect(calls[1].stdin).toBe('and then')
    })

    it('titles a chat with no text after its first attachment', async () => {
      const c = await store.create('helper', dir)
      await write(c.id, [img])
      await svc.send(c.id, '', [img])
      expect((await store.get(c.id))?.title).toBe(makeTitle(img.name))
    })

    it("an expired session's seed lists earlier attachments and resends this message's images", async () => {
      const c = await store.create('helper', dir)
      await write(c.id, [txt, img])
      await svc.send(c.id, 'first', [txt])
      const prior = await itemsOf(c.id)
      scripts.push({
        events: [],
        outcome: { result: { ...okResult, isError: true } as RunOutcome['result'], stderr: 'No conversation found with session ID: s1' }
      })
      await svc.send(c.id, 'second', [img])
      const refs = refsOf([img], (a) => files.pathOf(c.id, a))
      const text = buildSeedPrompt(
        withNotes(prior, (a) => files.pathOf(c.id, a)),
        withNote('second', refs)
      )
      expect(calls[2].stdin).toEqual([{ type: 'text', text }, imageBlock])
    })
  })
})

describe('browser handoff turns', () => {
  it('injects the real upload contract and discoverable attachment IDs, including an expired-session seed', async () => {
    const service = await serveBrowserIpc({
      capabilities: new BrowserCapabilities(),
      manager: {
        run: async () => ({ ok: true, data: null }),
        registerTurn: () => () => {},
        endTurn: async () => {}
      }
    })
    try {
      svc = makeService({ browserTurns: { profileId: async () => 'profile', create: service.createBrowserTurn } })
      const c = await store.create('helper', dir)
      const attached: Attachment = { id: 'opaque-attached-id', name: 'report.txt', mime: 'text/plain', size: 5, kind: 'file' }
      await svc.send(c.id, 'Upload this report', [attached])
      scripts.push({ outcome: { result: null, stderr: 'No conversation found with session ID: s1' } }, { events: [okResult] })
      await svc.send(c.id, 'Try the attached report again')
      for (const call of calls) {
        const prompt = call.args[call.args.indexOf('--append-system-prompt') + 1]
        expect(prompt).toContain('browser_upload')
        expect(prompt).toContain('explicitly attached')
        expect(prompt).toContain('file ID')
        expect(prompt).toContain('fresh stamp')
        expect(prompt).toContain('native file picker')
        expect(prompt).toContain('Never pass filesystem paths')
        expect(prompt).not.toContain('uploads are not supported')
      }
      for (const index of [0, 2]) {
        expect(calls[index].stdin).toContain('file ID: opaque-attached-id')
        expect(calls[index].stdin).toContain(files.pathOf(c.id, attached))
        expect(calls[index].args).toContain('--add-dir')
      }
    } finally {
      await service.close()
    }
  })
  it('gives every retry a fresh capability, preserves prompt/args and disposes before the next attempt', async () => {
    const owners: BrowserOwner[] = [],
      order: string[] = []
    svc = makeService({
      browserTurns: {
        profileId: async () => 'profile',
        create: async (owner, _handoff) => {
          owners.push(owner)
          order.push('create')
          return {
            mcp: NO_MCP,
            args: ['--browser-test'],
            env: { ZUMIBOT_BROWSER_CAPABILITY: owner.turnId },
            prompt: 'Scoped browser instructions',
            dispose: async () => {
              order.push('dispose')
            }
          }
        }
      }
    })
    const c = await store.create('helper', dir)
    await store.update(c.id, { sessionId: 'old' })
    scripts.push({ outcome: { result: null, stderr: 'No conversation found with session ID: old' } }, { events: [okResult] })
    await svc.send(c.id, 'go')
    expect(owners).toHaveLength(2)
    expect(owners[0].turnId).toMatch(/^[a-f0-9-]{36}$/)
    expect(owners[1].turnId).not.toBe(owners[0].turnId)
    expect(order).toEqual(['create', 'dispose', 'create', 'dispose'])
    for (const call of calls) {
      expect(call.args).toContain('--browser-test')
      expect(call.args[call.args.indexOf('--append-system-prompt') + 1]).toContain('Scoped browser instructions')
      expect(call.env?.ZUMIBOT_BROWSER_CAPABILITY).toMatch(/^[a-f0-9-]{36}$/)
    }
  })

  it('persists handoff pending and terminal through the current ref, counts waiting, and keeps immutable identity on stop', async () => {
    let publish!: (handoff: BrowserHandoff) => Promise<void>
    let own!: BrowserOwner
    svc = makeService({
      browserTurns: {
        profileId: async () => 'profile',
        create: async (owner, handoff) => {
          own = owner
          publish = handoff
          return {
            mcp: NO_MCP,
            args: [],
            env: {},
            prompt: 'Browser instructions',
            dispose: async () => {
              await publish({ ...card(), status: 'interrupted' })
            }
          }
        }
      }
    })
    const card = (): BrowserHandoff => ({
      ...own,
      id: 'browser-card',
      agent: 'helper',
      generation: 'generation',
      site: 'example.com',
      reason: 'Sign in',
      createdAt: 1000,
      status: 'pending'
    })
    const c = await store.create('helper', dir)
    const running = svc.claim(c.id)
    let items: ChatItem[] = []
    const ref = {
      get: () => items,
      set: (next: ChatItem[]) => {
        items = next
      }
    }
    scripts.push({ hang: true })
    const done = svc.agentTurn(
      c.id,
      running,
      {
        agentName: 'helper',
        author: 'helper',
        turnId: 'group-turn',
        sessionId: null,
        prompt: 'go',
        seedPrompt: () => 'seed',
        extraArgs: [],
        disallowedTools: [],
        allowScope: 'scope',
        saveSession: async () => {}
      },
      ref
    )
    await tick()
    await publish(card())
    expect(svc.pendingCount(c.id)).toBe(1)
    svc.answer(c.id, 'browser-card', 'allow-once')
    expect(svc.pendingCount(c.id)).toBe(1)
    items = [...items, { type: 'user', id: 'concurrent', text: 'other group message', ts: 1001 }]
    svc.stop(c.id)
    await done
    svc.release(c.id, running)
    expect(svc.pendingCount(c.id)).toBe(0)
    const saved = await store.loadItems(c.id)
    expect(saved).toContainEqual(expect.objectContaining({ id: 'concurrent' }))
    expect(saved.find((i) => i.type === 'browser-action')).toMatchObject({
      agent: 'helper',
      turn: 'group-turn',
      handoff: { turnId: own.turnId, status: 'interrupted' }
    })
  })

  it('a vault approval counts as pending and pushes approvals', async () => {
    let publish!: (request: VaultApprovalRequest) => Promise<void>
    let turnId = ''
    let unregistered = false
    svc = makeService({
      vaultApprovals: {
        registerTurn: (id, cb) => {
          turnId = id
          publish = cb
          return () => {
            unregistered = true
          }
        }
      }
    })
    const request = (status: VaultApprovalRequest['status']): VaultApprovalRequest => ({
      id: 'vault-card',
      chatId: c.id,
      turnId,
      profileId: 'profile',
      itemId: 'i1',
      itemName: 'Work Visa',
      label: 'Visa •4242',
      site: 'shop.example.com',
      frameSite: 'js.stripe.com',
      status
    })
    const c = await store.create('helper', dir)
    const running = svc.claim(c.id)
    let items: ChatItem[] = []
    const ref = {
      get: () => items,
      set: (next: ChatItem[]) => {
        items = next
      }
    }
    scripts.push({ hang: true })
    const done = svc.agentTurn(
      c.id,
      running,
      {
        agentName: 'helper',
        author: 'helper',
        turnId: 'group-turn',
        sessionId: null,
        prompt: 'go',
        seedPrompt: () => 'seed',
        extraArgs: [],
        disallowedTools: [],
        allowScope: 'scope',
        saveSession: async () => {}
      },
      ref
    )
    await tick()
    await publish(request('pending'))
    expect(svc.pendingCount(c.id)).toBe(1)
    expect(pushes.filter((x) => x.kind === 'approvals').at(-1)).toEqual({ chatId: c.id, kind: 'approvals', pending: 1, agent: 'helper' })
    expect(items.find((i) => i.type === 'vault-approval')).toMatchObject({
      id: 'vault-card',
      agent: 'helper',
      turn: 'group-turn',
      request: { status: 'pending', itemName: 'Work Visa' }
    })
    // The answer updates the same card and the count falls.
    await publish(request('allowed'))
    expect(svc.pendingCount(c.id)).toBe(0)
    expect(items.filter((i) => i.type === 'vault-approval')).toHaveLength(1)
    expect(items.find((i) => i.type === 'vault-approval')).toMatchObject({ request: { status: 'allowed' } })
    await publish({ ...request('pending'), id: 'second' })
    expect(svc.pendingCount(c.id)).toBe(1)
    // The turn ending leaves no card waiting.
    svc.stop(c.id)
    await done
    svc.release(c.id, running)
    expect(unregistered).toBe(true)
    expect(svc.pendingCount(c.id)).toBe(0)
    const saved = await store.loadItems(c.id)
    expect(saved.find((i) => i.type === 'vault-approval' && i.id === 'second')).toMatchObject({ request: { status: 'interrupted' } })
  })

  it('a turn ending with a vault card pending (signal never aborted) pushes approvals 0 and stores the card interrupted', async () => {
    let publish!: (request: VaultApprovalRequest) => Promise<void>
    let turnId = ''
    // The unregister does nothing here: the fill call's signal did not abort first (CLI death, error, server stop).
    svc = makeService({
      vaultApprovals: {
        registerTurn: (id, cb) => {
          turnId = id
          publish = cb
          return () => {}
        }
      }
    })
    const c = await store.create('helper', dir)
    const running = svc.claim(c.id)
    let items: ChatItem[] = []
    const ref = {
      get: () => items,
      set: (next: ChatItem[]) => {
        items = next
      }
    }
    scripts.push({ hang: true })
    const done = svc.agentTurn(
      c.id,
      running,
      {
        agentName: 'helper',
        author: 'helper',
        turnId: 'group-turn',
        sessionId: null,
        prompt: 'go',
        seedPrompt: () => 'seed',
        extraArgs: [],
        disallowedTools: [],
        allowScope: 'scope',
        saveSession: async () => {}
      },
      ref
    )
    await tick()
    await publish({
      id: 'vault-card',
      chatId: c.id,
      turnId,
      profileId: 'profile',
      itemId: 'i1',
      itemName: 'Work Visa',
      label: 'Visa •4242',
      site: 'shop.example.com',
      frameSite: 'shop.example.com',
      status: 'pending'
    })
    expect(pushes.filter((x) => x.kind === 'approvals').at(-1)).toMatchObject({ pending: 1 })
    svc.stop(c.id)
    await done
    svc.release(c.id, running)
    expect(pushes.filter((x) => x.kind === 'approvals').at(-1)).toMatchObject({ chatId: c.id, pending: 0 })
    expect((await store.loadItems(c.id)).find((i) => i.type === 'vault-approval')).toMatchObject({ request: { status: 'interrupted' } })
  })

  it('keeps a text turn usable when browser metadata is unavailable and forbids system browser fallback', async () => {
    const create = vi.fn()
    svc = makeService({ browserTurns: { profileId: async () => null, create } })
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'hello')
    expect(create).not.toHaveBeenCalled()
    expect(calls[0].args).toContain('--no-chrome')
    expect(calls[0].args.join(' ')).toContain('unavailable')
    expect((await store.loadItems(c.id)).some((i) => i.type === 'assistant')).toBe(true)
  })
})

it('browser transcript summaries keep the original private permission input for allow responses', async () => {
  const c = await store.create('helper', dir)
  const input = { text: 'private-typed-value', ref: 'ref1' }
  const up = hangUntilReady([
      { kind: 'toolUse', id: 'browser-tool', name: 'mcp__zumibot_browser__browser_type', input },
      {
        kind: 'permissionRequest',
        requestId: 'browser-permission',
        toolName: 'mcp__zumibot_browser__browser_type',
        input,
        description: 'private-typed-value',
        reason: 'private-typed-value',
        toolUseId: 'browser-tool'
      },
      { kind: 'toolResult', toolUseId: 'browser-tool', content: 'private-page-observation-or-base64', isError: false }
    ])
  const done = svc.send(c.id, 'go')
  await up
  await tick()
  expect(JSON.stringify(await store.loadItems(c.id))).not.toContain('private-typed-value')
  expect(JSON.stringify(await store.loadItems(c.id))).not.toContain('private-page-observation-or-base64')
  svc.answer(c.id, 'browser-permission', 'allow-once')
  expect(sent).toEqual([allowResponse('browser-permission', input)])
  svc.stop(c.id)
  await done
})

it('browser capability and private IPC values never enter chat errors when runner startup fails', async () => {
  let disposed = false
  svc = makeService({
    browserTurns: {
      profileId: async () => 'profile',
      create: async () => ({
        mcp: NO_MCP,
        args: [],
        env: { ZUMIBOT_BROWSER_CAPABILITY: 'private-capability-value', ZUMIBOT_BROWSER_IPC: '/tmp/private-browser-ipc' },
        prompt: 'Browser instructions',
        dispose: async () => {
          disposed = true
        }
      })
    },
    run: () => {
      throw new Error('Failed private-capability-value /tmp/private-browser-ipc')
    }
  })
  const c = await store.create('helper', dir)
  await svc.send(c.id, 'go')
  expect(disposed).toBe(true)
  expect(JSON.stringify(await store.loadItems(c.id))).not.toContain('private-capability-value')
  expect(JSON.stringify(await store.loadItems(c.id))).not.toContain('/tmp/private-browser-ipc')
})

it('browser retries retain the authorized profile through a gated live rename while receiving fresh attempt IDs', async () => {
  let finish!: (outcome: RunOutcome) => void
  const owners: BrowserOwner[] = [],
    resolved: string[] = []
  svc = makeService({
    browserTurns: {
      profileId: async (agent) => {
        resolved.push(agent)
        if (agent !== 'helper') throw new Error('Must not rebind a live turn after rename')
        return 'original-profile'
      },
      create: async (owner) => {
        owners.push(owner)
        return { mcp: NO_MCP, args: [], env: {}, prompt: 'Browser instructions', dispose: async () => {} }
      }
    },
    run: (o) => {
      calls.push(o)
      return {
        done:
          calls.length === 1
            ? new Promise<RunOutcome>((resolve) => {
                finish = resolve
              })
            : Promise.resolve(baseOutcome()),
        stop: () => {},
        send: () => true
      }
    }
  })
  const c = await store.create('helper', dir)
  await store.update(c.id, { sessionId: 'old' })
  const done = svc.send(c.id, 'go')
  await tick()
  svc.renameAgent('helper', 'renamed')
  await store.renameAgent('helper', 'renamed')
  finish(baseOutcome({ result: null, stderr: 'No conversation found with session ID: old' }))
  await done
  expect(resolved).toEqual(['helper'])
  expect(owners).toHaveLength(2)
  expect(owners.map((owner) => owner.profileId)).toEqual(['original-profile', 'original-profile'])
  expect(owners[0].turnId).not.toBe(owners[1].turnId)
  expect(calls[1].args.slice(0, 3)).toEqual(['-p', '--agent', 'renamed'])
})

describe('desktop turns', () => {
  const click = { stamp: { generation: 'g', epoch: 1, observationId: 'o' }, x: 412, y: 300 }
  const CLICK = desktopToolName('desktop_click')
  let ipc: Awaited<ReturnType<typeof serveDesktopIpc>> | undefined
  afterEach(async () => {
    await ipc?.close()
    ipc = undefined
  })
  // The real per-turn args, env and prompt from the desktop IPC, with a manager that never runs anything.
  const realDesktop = async (plan: DesktopPlan = { profileId: 'desktop-profile' }) => {
    ipc = await serveDesktopIpc({
      capabilities: new BrowserCapabilities(),
      manager: { run: async () => ({ ok: true, data: null }), registerTurn: () => () => {}, endTurn: async () => {} },
      runtime: { node: process.execPath, bridgeEntry: '/opt/zumibot/desktopBridge.mjs', electronNode: false }
    })
    return { plan: vi.fn(async (_agent: string, _chatId: string) => plan), create: vi.fn(ipc.createDesktopTurn) }
  }
  const fakeTurn = (extra: Partial<DesktopTurn> = {}): DesktopTurn => ({
    mcp: NO_MCP,
    args: ['--mcp-config', 'desktop-config', '--settings', JSON.stringify({ permissions: { ask: DESKTOP_ASK_RULES } })],
    env: {},
    prompt: 'Desktop prompt',
    dispose: async () => {},
    ...extra
  })
  const plain = () => buildArgs({ agentName: 'helper', effort: 'medium', resumeSessionId: null, permissionMode: 'auto' })

  it('agent without computerUse gets no desktop args', async () => {
    const turns = { plan: vi.fn(async () => 'off' as const), create: vi.fn() }
    svc = makeService({ desktopTurns: turns })
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'hello')
    expect(turns.plan).toHaveBeenCalledWith('helper', c.id)
    expect(turns.create).not.toHaveBeenCalled()
    expect(calls[0].args).toEqual(plain())
    expect(calls[0].env).toBeUndefined()
    expect(svc.sideBase(c.id, 'helper')!.desktop).toBe(false)
    expect(await svc.sideDesktop(c.id, 'helper')).toBeNull()
    expect(await makeService().sideDesktop(c.id, 'helper')).toBeNull()
  })

  it('computerUse agent gets mcp-config and ask settings and the desktop prompt', async () => {
    const desktop = await realDesktop()
    svc = makeService({
      desktopTurns: desktop,
      disallowedToolsFor: () => ['Agent(other)'],
      browserTurns: {
        profileId: async () => 'browser-profile',
        create: async () => ({
          mcp: NO_MCP,
          args: ['--mcp-config', '{"mcpServers":{"zumibot_browser":{}}}', '--no-chrome'],
          env: { ZUMIBOT_BROWSER_CAPABILITY: 'browser-cap' },
          prompt: 'Browser prompt',
          dispose: async () => {}
        })
      }
    })
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'hello')
    expect(desktop.create).toHaveBeenCalledWith(
      { profileId: 'desktop-profile', chatId: c.id, turnId: expect.stringMatching(/^[a-f0-9-]{36}$/) },
      expect.any(Function)
    )
    const args = calls[0].args
    // Exactly one --settings, and it forces a card for all 8 action tools.
    expect(args.filter((a) => a === '--settings')).toHaveLength(1)
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({ permissions: { ask: DESKTOP_ACTION_TOOLS.map(desktopToolName) } })
    expect(DESKTOP_ASK_RULES).toHaveLength(8)
    // The desktop's server comes after the browser's; every variadic --mcp-config value is followed by an option; the deny list is last.
    const configs = args.flatMap((a, i) => (a === '--mcp-config' ? [i] : []))
    expect(configs.map((i) => JSON.parse(args[i + 1]).mcpServers)).toEqual([
      { zumibot_browser: {} },
      { zumibot_desktop: expect.any(Object) }
    ])
    for (const i of configs) expect(args[i + 2].startsWith('--')).toBe(true)
    expect(args.slice(-2)).toEqual(['--disallowedTools', 'Agent(other)'])
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe(['Browser prompt', desktopPrompt].join('\n\n'))
    expect(calls[0].env).toMatchObject({
      ZUMIBOT_BROWSER_CAPABILITY: 'browser-cap',
      ZUMIBOT_DESKTOP_CAPABILITY: expect.any(String),
      ZUMIBOT_DESKTOP_IPC: expect.any(String)
    })
    // The side base leaves the desktop parts out, as it does the browser's.
    const b = svc.sideBase(c.id, 'helper')!
    expect(b.desktop).toBe(true)
    expect(b.args.extraArgs).toEqual([])
    expect(b.args.appendSystemPrompt).toBe('')
  })

  it('plans once per logical turn and gives every retry a fresh desktop turn', async () => {
    const owners: DesktopOwner[] = [],
      order: string[] = []
    const turns = {
      plan: vi.fn(async () => ({ profileId: 'desktop-profile' })),
      create: vi.fn(async (owner: DesktopOwner) => {
        owners.push(owner)
        order.push('create')
        return fakeTurn({
          dispose: async () => {
            order.push('dispose')
          }
        })
      })
    }
    svc = makeService({ desktopTurns: turns })
    const c = await store.create('helper', dir)
    await store.update(c.id, { sessionId: 'old' })
    scripts.push({ outcome: { result: null, stderr: 'No conversation found with session ID: old' } }, { events: [okResult] })
    await svc.send(c.id, 'go')
    expect(turns.plan).toHaveBeenCalledTimes(1)
    expect(owners).toHaveLength(2)
    expect(owners[1]).toMatchObject({ profileId: 'desktop-profile', chatId: c.id })
    expect(owners[1].turnId).not.toBe(owners[0].turnId)
    expect(order).toEqual(['create', 'dispose', 'create', 'dispose'])
    for (const call of calls) expect(call.args).toContain('desktop-config')
  })

  it('unavailable adds only the unavailable prompt', async () => {
    const turns = { plan: vi.fn(async () => 'unavailable' as const), create: vi.fn() }
    svc = makeService({ desktopTurns: turns })
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'hello')
    expect(turns.create).not.toHaveBeenCalled()
    expect(calls[0].args).toEqual(
      buildArgs({
        agentName: 'helper',
        effort: 'medium',
        resumeSessionId: null,
        permissionMode: 'auto',
        appendSystemPrompt: desktopUnavailablePrompt
      })
    )
    expect(calls[0].env ?? {}).toEqual({})
    expect((await itemsOf(c.id)).some((i) => i.type === 'assistant')).toBe(true)
    expect(svc.sideBase(c.id, 'helper')!.desktop).toBe(true)
    expect(await svc.sideDesktop(c.id, 'helper')).toMatchObject({ args: [], env: {}, prompt: desktopUnavailablePrompt })
  })

  it('desktop approval card keeps its input, and the risk hint runs for it', async () => {
    const risk = vi.fn(async () => 'medium' as const)
    svc = makeService({ desktopTurns: { plan: async () => ({ profileId: 'p' }), create: async () => fakeTurn() }, approvalRisk: risk })
    const c = await store.create('helper', dir)
    let ready!: () => void
    const emitted = new Promise<void>((resolve) => {
      ready = resolve
    })
    scripts.push({
      hang: true,
      ready,
      events: [
        { kind: 'toolUse', id: 'd1', name: CLICK, input: click },
        {
          kind: 'permissionRequest',
          requestId: 'r1',
          toolName: CLICK,
          input: click,
          description: 'Click Save',
          reason: 'Save the file',
          toolUseId: 'd1'
        }
      ]
    })
    const done = svc.send(c.id, 'go')
    await emitted
    await tick()
    const items = await itemsOf(c.id)
    expect(items.find((i) => i.type === 'tool')).toMatchObject({ name: CLICK, input: click })
    expect(items.find((i) => i.type === 'approval')).toMatchObject({
      toolName: CLICK,
      input: click,
      description: 'Click Save',
      reason: 'Save the file',
      status: 'pending',
      risk: 'medium'
    })
    expect(risk).toHaveBeenCalledWith(c.id, { toolName: CLICK, input: click, description: 'Click Save', reason: 'Save the file' })
    expect(svc.pendingCount(c.id)).toBe(1)
    // "Allow always for this agent" works for desktop tools as for any other: by tool name.
    svc.answer(c.id, 'r1', 'allow-agent')
    expect(sent).toEqual([allowResponse('r1', click)])
    expect(rules.added).toEqual([['helper', ruleOf(CLICK, click)]])
    emit({
      kind: 'permissionRequest',
      requestId: 'r2',
      toolName: CLICK,
      input: { ...click, x: 5 },
      description: null,
      reason: null,
      toolUseId: null
    })
    expect(svc.pendingCount(c.id)).toBe(0)
    svc.stop(c.id)
    await done
    expect((await itemsOf(c.id)).filter((i) => i.type === 'approval').map((i) => (i as { status: string }).status)).toEqual([
      'allowed-agent',
      'auto-allowed-agent'
    ])
  })

  it('the risk hint never gets typed text, while the card still shows it', async () => {
    const risk = vi.fn(async () => 'low' as const)
    svc = makeService({ desktopTurns: { plan: async () => ({ profileId: 'p' }), create: async () => fakeTurn() }, approvalRisk: risk })
    const c = await store.create('helper', dir)
    const TYPE = desktopToolName('desktop_type'),
      KEY = desktopToolName('desktop_key')
    const stamp = click.stamp
    const typed = { stamp, text: 'hunter2 مرحبا' },
      intoField = { stamp, text: 'secret-into-field', element: 'e4' },
      keys = { stamp, keys: ['ctrl', 's'] }
    let ready!: () => void
    const emitted = new Promise<void>((resolve) => {
      ready = resolve
    })
    scripts.push({
      hang: true,
      ready,
      events: [
        { kind: 'permissionRequest', requestId: 'r1', toolName: TYPE, input: typed, description: null, reason: null, toolUseId: null },
        { kind: 'permissionRequest', requestId: 'r2', toolName: TYPE, input: intoField, description: null, reason: null, toolUseId: null },
        { kind: 'permissionRequest', requestId: 'r3', toolName: KEY, input: keys, description: null, reason: null, toolUseId: null },
        { kind: 'permissionRequest', requestId: 'r4', toolName: CLICK, input: click, description: null, reason: null, toolUseId: null }
      ]
    })
    const done = svc.send(c.id, 'go')
    await emitted
    await tick()
    const asked = risk.mock.calls.map((call) => (call as unknown[])[1] as { toolName: string; input: unknown })
    expect(asked.map((a) => a.input)).toEqual([{ stamp, text: '<13 chars>' }, { stamp, text: '<17 chars>', element: 'e4' }, keys, click])
    expect(JSON.stringify(risk.mock.calls)).not.toContain('hunter2')
    expect(JSON.stringify(risk.mock.calls)).not.toContain('secret-into-field')
    const cards = (await itemsOf(c.id)).filter((i) => i.type === 'approval')
    expect(cards.map((i) => (i as { input: unknown }).input)).toEqual([typed, intoField, keys, click])
    svc.answer(c.id, 'r1', 'allow-once')
    expect(sent).toEqual([allowResponse('r1', typed)])
    svc.stop(c.id)
    await done
  })

  it('desktop tool result is summarized and has no image', async () => {
    const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB-private-screenshot'
    svc = makeService({ desktopTurns: { plan: async () => ({ profileId: 'p' }), create: async () => fakeTurn() } })
    const c = await store.create('helper', dir)
    scripts.push({
      events: [
        { kind: 'toolUse', id: 'd1', name: desktopToolName('desktop_screenshot'), input: {} },
        { kind: 'toolResult', toolUseId: 'd1', content: `{"stamp":{}}\n[image ${image}]`, isError: false },
        { kind: 'toolUse', id: 'd2', name: CLICK, input: click },
        { kind: 'toolResult', toolUseId: 'd2', content: '{"ok":false,"code":"stale","message":"The desktop changed"}', isError: true },
        okResult
      ]
    })
    await svc.send(c.id, 'go')
    const tools = (await itemsOf(c.id)).filter((i) => i.type === 'tool')
    expect(tools).toMatchObject([
      { id: 'd1', input: {}, result: 'Desktop command completed.', isError: false },
      { id: 'd2', input: click, result: 'Desktop command failed.', isError: true }
    ])
    expect(JSON.stringify(await itemsOf(c.id))).not.toContain(image)
    expect(JSON.stringify(pushes)).not.toContain(image)
  })

  it('desktop handoff adds a browser-action card with surface desktop and counts as pending', async () => {
    let publish!: (handoff: DesktopHandoff) => Promise<void>
    let own!: DesktopOwner
    svc = makeService({
      desktopTurns: {
        plan: async () => ({ profileId: 'desktop-profile' }),
        create: async (owner, handoff) => {
          own = owner
          publish = handoff
          return fakeTurn({
            dispose: async () => {
              await publish({ ...card(), status: 'interrupted' })
            }
          })
        }
      }
    })
    const card = (): DesktopHandoff => ({
      ...own,
      id: 'desktop-card',
      agent: 'helper',
      generation: 'generation',
      site: '',
      reason: 'Sign in',
      createdAt: 1000,
      status: 'pending'
    })
    const c = await store.create('helper', dir)
    const running = svc.claim(c.id)
    let items: ChatItem[] = []
    const ref = {
      get: () => items,
      set: (next: ChatItem[]) => {
        items = next
      }
    }
    scripts.push({ hang: true })
    const done = svc.agentTurn(
      c.id,
      running,
      {
        agentName: 'helper',
        author: 'helper',
        turnId: 'group-turn',
        sessionId: null,
        prompt: 'go',
        seedPrompt: () => 'seed',
        extraArgs: [],
        disallowedTools: [],
        allowScope: 'scope',
        saveSession: async () => {}
      },
      ref
    )
    await tick()
    await publish(card())
    expect(items.filter((i) => i.type === 'browser-action')).toEqual([
      { type: 'browser-action', surface: 'desktop', id: 'desktop-card', ts: 1000, agent: 'helper', turn: 'group-turn', handoff: card() }
    ])
    expect(svc.pendingCount(c.id)).toBe(1)
    expect(pushes.filter((p) => p.kind === 'approvals').at(-1)).toMatchObject({ pending: 1, agent: 'helper' })
    svc.stop(c.id)
    await done
    svc.release(c.id, running)
    expect(svc.pendingCount(c.id)).toBe(0)
    const saved = (await store.loadItems(c.id)).filter((i) => i.type === 'browser-action')
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ surface: 'desktop', handoff: { turnId: own.turnId, status: 'interrupted' } })
  })

  it('capability value is redacted from errors', async () => {
    let disposed = false
    svc = makeService({
      desktopTurns: {
        plan: async () => ({ profileId: 'p' }),
        create: async () =>
          fakeTurn({
            env: { ZUMIBOT_DESKTOP_CAPABILITY: 'private-desktop-capability', ZUMIBOT_DESKTOP_IPC: '/tmp/cb-d-private/s' },
            dispose: async () => {
              disposed = true
            }
          })
      },
      run: () => {
        throw new Error('Failed private-desktop-capability /tmp/cb-d-private/s')
      }
    })
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'go')
    expect(disposed).toBe(true)
    const saved = JSON.stringify(await store.loadItems(c.id))
    expect(saved).not.toContain('private-desktop-capability')
    expect(saved).not.toContain('/tmp/cb-d-private/s')
    expect(saved).toContain('[private desktop value]')
  })

  it('a failing desktop setup still disposes the browser turn', async () => {
    let browserDisposed = false
    svc = makeService({
      browserTurns: {
        profileId: async () => 'b',
        create: async () => ({
          mcp: NO_MCP,
          args: [],
          env: {},
          prompt: '',
          dispose: async () => {
            browserDisposed = true
          }
        })
      },
      desktopTurns: {
        plan: async () => ({ profileId: 'p' }),
        create: async () => {
          throw new Error('Desktop unavailable')
        }
      }
    })
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'go')
    expect(browserDisposed).toBe(true)
    expect(calls).toHaveLength(0)
    expect((await itemsOf(c.id)).find((i) => i.type === 'error')).toMatchObject({ text: 'Desktop unavailable' })
  })

  it('stop disposes the desktop turn at once', async () => {
    const dispose = vi.fn(async () => {})
    svc = makeService({ desktopTurns: { plan: async () => ({ profileId: 'p' }), create: async () => fakeTurn({ dispose }) } })
    const c = await store.create('helper', dir)
    let ready!: () => void
    const emitted = new Promise<void>((resolve) => {
      ready = resolve
    })
    scripts.push({ hang: true, ready })
    const done = svc.send(c.id, 'go')
    await emitted
    svc.stop(c.id)
    expect(dispose).toHaveBeenCalled()
    await done
  })

  it('sideDesktop makes a fresh side capability without adding handoff cards', async () => {
    const desktop = await realDesktop()
    svc = makeService({ desktopTurns: desktop })
    const c = await store.create('helper', dir)
    const first = (await svc.sideDesktop(c.id, 'helper'))!,
      second = (await svc.sideDesktop(c.id, 'helper'))!
    expect(desktop.create).toHaveBeenCalledWith(
      { profileId: 'desktop-profile', chatId: c.id, turnId: expect.any(String) },
      expect.any(Function),
      { side: true }
    )
    expect(first.args).toEqual(['--mcp-config', expect.stringContaining('zumibot_desktop')])
    expect(first.prompt).toBe(desktopPrompt)
    expect(first.env.ZUMIBOT_DESKTOP_CAPABILITY).not.toBe(second.env.ZUMIBOT_DESKTOP_CAPABILITY)
    expect(await itemsOf(c.id)).toEqual([])
    expect(pushes).toEqual([])
    await first.dispose()
    await second.dispose()
  })

  it('two room members with computer use get their own desktop turns', async () => {
    const owners: DesktopOwner[] = []
    svc = makeService({
      desktopTurns: {
        plan: async (agent) => (agent === 'plain' ? 'off' : { profileId: `profile-${agent}` }),
        create: async (owner) => {
          owners.push(owner)
          return fakeTurn({ args: ['--mcp-config', `config-${owner.profileId}`, '--settings', '{}'] })
        }
      }
    })
    const c = await store.create('ui', dir)
    const running = svc.claim(c.id)
    let items: ChatItem[] = []
    const ref = {
      get: () => items,
      set: (next: ChatItem[]) => {
        items = next
      }
    }
    const member = (name: string) =>
      svc.agentTurn(
        c.id,
        running,
        {
          agentName: name,
          author: name,
          turnId: `turn-${name}`,
          sessionId: null,
          prompt: 'go',
          seedPrompt: () => 'seed',
          extraArgs: [],
          disallowedTools: [],
          allowScope: `${c.id}:${name}`,
          saveSession: async () => {}
        },
        ref
      )
    await Promise.all([member('ui'), member('wk'), member('plain')])
    svc.release(c.id, running)
    expect(owners.map((o) => o.profileId).sort()).toEqual(['profile-ui', 'profile-wk'])
    const byAgent = (name: string) => calls.find((call) => call.args[call.args.indexOf('--agent') + 1] === name)!.args
    expect(byAgent('ui')).toContain('config-profile-ui')
    expect(byAgent('wk')).toContain('config-profile-wk')
    expect(byAgent('plain')).not.toContain('--mcp-config')
  })
})

describe('edit, resend and switch (single chats)', () => {
  const turnOf = (session: string, text: string, tip: string, extra: RunEvent[] = []): RunEvent[] => [
    { kind: 'init', sessionId: session, version: '2.1.299' },
    ...extra,
    { kind: 'entry', uuid: tip },
    { kind: 'assistantText', text },
    okResult
  ]
  const missing = { exitCode: 1, stderr: 'No conversation found with session ID: s1', result: null }
  const argAfter = (o: RunOptions, flag: string) => o.args[o.args.indexOf(flag) + 1]

  // Two stamped turns: 'one' -> e1, 'two' -> e2, both in session s1.
  const stampedChat = async () => {
    const c = await store.create('helper', dir)
    scripts.push({ events: turnOf('s1', 'A1', 'e1') }, { events: turnOf('s1', 'A2', 'e2') })
    await svc.send(c.id, 'one')
    await svc.send(c.id, 'two')
    const items = await itemsOf(c.id)
    return { c, items, second: items[2] }
  }
  const shape = (items: ChatItem[]) => items.map((i) => (i.type === 'notice' ? `notice:${i.kind}` : i.type))

  it("assistant items carry cut and the turn's last item carries end", async () => {
    const c = await store.create('helper', dir)
    scripts.push({
      events: [
        { kind: 'init', sessionId: 's1' },
        { kind: 'entry', uuid: 'u1' },
        { kind: 'assistantText', text: 'looking' },
        { kind: 'entry', uuid: 'u2' },
        { kind: 'toolUse', id: 't1', name: 'Bash', input: {} },
        { kind: 'entry', uuid: 'u3' },
        { kind: 'toolResult', toolUseId: 't1', content: 'ok', isError: false },
        { kind: 'entry', uuid: 'u4' },
        { kind: 'assistantText', text: 'done' },
        okResult
      ]
    })
    await svc.send(c.id, 'go')
    const items = await itemsOf(c.id)
    expect(shape(items)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(items[1]).toMatchObject({ cut: { session: 's1', at: 'u1' } })
    expect(items[3]).toMatchObject({ cut: { session: 's1', at: 'u4' }, end: { session: 's1', at: 'u4' } })
    expect(items.filter((i) => i.end)).toHaveLength(1)
  })

  it('a send after a stamped turn resumes plainly with no resume-at', async () => {
    const { c } = await stampedChat()
    expect(calls[1].args).toContain('--resume')
    expect(calls[1].args).not.toContain('--resume-session-at')
    expect(calls[1].args).not.toContain('--fork-session')
    expect((await store.get(c.id))?.next).toBeUndefined()
  })

  it("rerun of the second message cuts at the first turn's end with fork", async () => {
    const { c, second } = await stampedChat()
    scripts.push({ events: turnOf('s2', 'B2', 'f1') })
    await svc.rerun(c.id, second.id, 'two, edited')
    const args = calls[2].args
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 5)).toEqual([
      '--resume',
      's1',
      '--resume-session-at',
      'e1',
      '--fork-session'
    ])
    expect(calls[2].stdin).toBe('two, edited')
    expect(shape(await itemsOf(c.id))).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(await store.get(c.id)).toMatchObject({ sessionId: 's2', inFlight: false })
    expect((await store.get(c.id))?.next).toBeUndefined()
  })

  it('rerun of the first message runs fresh: no --resume, no expired notice', async () => {
    const { c, items } = await stampedChat()
    scripts.push({ events: turnOf('s9', 'B1', 'g1') })
    await svc.rerun(c.id, items[0].id, 'one, edited')
    expect(calls[2].args).not.toContain('--resume')
    expect(calls[2].stdin).toBe('one, edited')
    const after = await itemsOf(c.id)
    expect(shape(after)).toEqual(['user', 'assistant'])
    expect(await store.get(c.id)).toMatchObject({ sessionId: 's9' })
  })

  it('rerun in a legacy chat seeds with the expired notice and never resumes', async () => {
    const c = await store.create('helper', dir)
    await store.update(c.id, { sessionId: 'old' })
    const legacy: ChatItem[] = [
      { type: 'user', id: 'u0', text: 'hello', ts: 1 },
      { type: 'assistant', id: 'a0', text: 'hi', ts: 2 },
      { type: 'user', id: 'u1', text: 'again', ts: 3 },
      { type: 'assistant', id: 'a1', text: 'yes', ts: 4 }
    ]
    await store.saveItems(c.id, legacy)
    scripts.push({ events: turnOf('n1', 'fresh', 'h1') })
    await svc.rerun(c.id, 'u1', 'again, edited')
    expect(calls).toHaveLength(1)
    expect(calls[0].args).not.toContain('--resume')
    expect(calls[0].stdin).toBe(buildSeedPrompt(legacy.slice(0, 2), 'again, edited'))
    expect(shape(await itemsOf(c.id))).toEqual(['user', 'assistant', 'user', 'notice:expired', 'assistant'])
    expect(await store.get(c.id)).toMatchObject({ sessionId: 'n1' })
  })

  it("a Claude turn's end stamp has no engine key, and an edit clears a Codex mark the stamp does not carry", async () => {
    const { c, items, second } = await stampedChat()
    expect(items[1].end).toEqual({ session: 's1', at: 'e1' })
    expect(items[1].end).not.toHaveProperty('engine')
    expect(items[3].type === 'assistant' && items[3].cut).toEqual({ session: 's1', at: 'e2' })
    // A leftover Codex mark on a chat whose stamps are Claude's: the cut session is Claude's, so the mark goes.
    await store.update(c.id, { sessionEngine: 'codex' })
    scripts.push({ events: turnOf('s2', 'B2', 'f1') })
    await svc.rerun(c.id, second.id, 'two, edited')
    expect(argAfter(calls[2], '--resume-session-at')).toBe('e1')
    expect((await store.get(c.id))?.sessionEngine).toBeUndefined()
  })

  it("a switch to a version whose stamp is Claude's clears a Codex mark too", async () => {
    const { c, second } = await stampedChat()
    scripts.push({ events: turnOf('s2', 'B2', 'f1') })
    await svc.rerun(c.id, second.id, 'two, edited')
    const shown = (await itemsOf(c.id))[2]
    await store.update(c.id, { sessionEngine: 'codex' })
    await svc.switchVersion(c.id, shown.id, 0)
    expect(await store.get(c.id)).toMatchObject({ sessionId: 's1', next: { at: 'e2' } })
    expect((await store.get(c.id))?.sessionEngine).toBeUndefined()
  })

  it('rerun stores the new command, not the old one', async () => {
    const { c, second } = await stampedChat()
    const command = { agent: 'helper', name: 'check', prompt: 'Use check on L' }
    scripts.push({ events: turnOf('s2', 'B2', 'f1') })
    await svc.rerun(c.id, second.id, '/check L', command)
    expect(calls[2].stdin).toBe('Use check on L')
    expect((await itemsOf(c.id))[2]).toMatchObject({ text: '/check L', command })
    // The old command must not follow a rerun that resolved to none.
    const shown = (await itemsOf(c.id))[2]
    scripts.push({ events: turnOf('s3', 'B3', 'f2') })
    await svc.rerun(c.id, shown.id, 'plain now')
    const after = (await itemsOf(c.id))[2]
    expect(after).toMatchObject({ text: 'plain now' })
    expect(after).not.toHaveProperty('command')
    expect(calls[3].stdin).toBe('plain now')
  })

  it('rerun hides the old tail as version 1 and shows 2 / 2', async () => {
    const { c, second } = await stampedChat()
    scripts.push({ events: turnOf('s2', 'B2', 'f1') })
    await svc.rerun(c.id, second.id, 'two, edited')
    const items = await itemsOf(c.id)
    const shown = items[2]
    expect(shown).toMatchObject({ type: 'user', text: 'two, edited', versions: { root: second.id, index: 1, count: 2 } })
    expect(shown.id).not.toBe(second.id)
    expect(items.some((i) => i.id === second.id || (i.type === 'assistant' && i.text === 'A2'))).toBe(false)
    const versions = await store.loadVersions(c.id)
    expect(versions[second.id].current).toBe(1)
    expect(versions[second.id].list[1]).toBeNull()
    expect(versions[second.id].list[0]).toMatchObject({ user: { id: second.id, text: 'two' }, tail: [{ type: 'assistant', text: 'A2' }] })
  })

  it('rerun with no text is a Resend: same text, attachments and reply', async () => {
    const { c, second } = await stampedChat()
    scripts.push({ events: turnOf('s2', 'B2', 'f1') })
    await svc.rerun(c.id, second.id, null)
    expect(calls[2].stdin).toBe('two')
    expect((await itemsOf(c.id))[2]).toMatchObject({ text: 'two', versions: { index: 1, count: 2 } })
  })

  it('rerun rejects an empty edit, a stale id and a running chat without touching the chat', async () => {
    const { c, second } = await stampedChat()
    const before = await itemsOf(c.id)
    await expect(svc.rerun(c.id, second.id, '  ')).rejects.toThrow('Message is empty')
    await expect(svc.rerun(c.id, 'nope', 'x')).rejects.toThrow('Message not found')
    expect(await itemsOf(c.id)).toEqual(before)
    expect(svc.isRunning(c.id)).toBe(false)
    const up = hangUntilReady()
    const p = svc.send(c.id, 'busy')
    await up
    await tick()
    await expect(svc.rerun(c.id, second.id, 'x')).rejects.toThrow('Chat is already running')
    svc.stop(c.id)
    await p
  })

  it('rerun adds no notice when the old version edited files', async () => {
    const c = await store.create('helper', dir)
    scripts.push({
      events: turnOf('s1', 'edited', 'e1', [
        { kind: 'toolUse', id: 't1', name: 'Edit', input: { file_path: '/p/a.ts' } },
        { kind: 'toolResult', toolUseId: 't1', content: 'ok', isError: false }
      ])
    })
    await svc.send(c.id, 'change a')
    const first = (await itemsOf(c.id))[0]
    scripts.push({ events: turnOf('s2', 'again', 'f1') })
    await svc.rerun(c.id, first.id, 'change b')
    const items = await itemsOf(c.id)
    expect(shape(items)).toEqual(['user', 'assistant'])
  })

  it('init with the same session id on a cut run stops it and shows FORK_IGNORED', async () => {
    const { c, second } = await stampedChat()
    // The CLI ignored --fork-session: it reports the session it resumed.
    scripts.push({ events: turnOf('s1', 'leak', 'f1') })
    await svc.rerun(c.id, second.id, 'two, edited')
    const items = await itemsOf(c.id)
    expect(items[items.length - 1]).toMatchObject({ type: 'error', text: FORK_IGNORED('2.1.299') })
    expect(items.some((i) => i.type === 'assistant' && i.text === 'leak')).toBe(false)
    expect(items.some((i) => i.type === 'notice')).toBe(false)
    expect(items.filter((i) => i.end).map((i) => i.id)).toEqual([items[1].id])
    // The session is not saved over the original, and the cut stays for a retry.
    expect(await store.get(c.id)).toMatchObject({ sessionId: 's1', next: { at: 'e1' }, inFlight: false })
  })

  it('FORK_IGNORED names the version when known', () => {
    expect(FORK_IGNORED('2.1.299')).toBe(
      "Claude Code 2.1.299 ignored --fork-session, so this reply was stopped before it could change an earlier version's memory. Edit, Resend, Fork and switching versions need an update for this Claude Code version."
    )
    expect(FORK_IGNORED(undefined)).toMatch(/^Claude Code ignored --fork-session/)
  })

  it('a cut run whose session is missing falls back to the seeded expired path', async () => {
    const { c, items, second } = await stampedChat()
    scripts.push({ outcome: missing }, { events: turnOf('n1', 'B2', 'f1') })
    await svc.rerun(c.id, second.id, 'two, edited')
    expect(calls).toHaveLength(4)
    expect(calls[2].args).toContain('--resume-session-at')
    expect(calls[3].args).not.toContain('--resume')
    expect(calls[3].args).not.toContain('--resume-session-at')
    expect(calls[3].stdin).toBe(buildSeedPrompt(items.slice(0, 2), 'two, edited'))
    expect(shape(await itemsOf(c.id))).toEqual(['user', 'assistant', 'user', 'notice:expired', 'assistant'])
    expect(await store.get(c.id)).toMatchObject({ sessionId: 'n1' })
    expect((await store.get(c.id))?.next).toBeUndefined()
  })

  it('a cut run that fails with another error shows it and never retries plainly', async () => {
    const { c, second } = await stampedChat()
    scripts.push({ outcome: { exitCode: 1, stderr: 'No message found with message.uuid of: e1', result: null } })
    await svc.rerun(c.id, second.id, 'two, edited')
    expect(calls).toHaveLength(3)
    const items = await itemsOf(c.id)
    expect(items[items.length - 1]).toMatchObject({ type: 'error', text: 'No message found with message.uuid of: e1' })
    // Even a result that looks like a missing session does not turn a cut run into a plain resume.
    scripts.push({
      outcome: {
        exitCode: 1,
        stderr: 'No message found with message.uuid of: e1',
        result: {
          kind: 'result',
          subtype: 'error_during_execution',
          isError: true,
          numTurns: 0,
          sessionId: '',
          denials: [],
          windows: {},
          uuid: null,
          cost: null
        }
      }
    })
    await svc.send(c.id, 'retry')
    expect(calls).toHaveLength(4)
  })

  it('next survives a run that fails before init, and is cleared by the first saved session', async () => {
    const { c, second } = await stampedChat()
    scripts.push({ outcome: { exitCode: 1, stderr: 'boom', result: null } })
    await svc.rerun(c.id, second.id, 'two, edited')
    expect(await store.get(c.id)).toMatchObject({ sessionId: 's1', next: { at: 'e1' } })
    scripts.push({ events: turnOf('s3', 'B2', 'f1') })
    await svc.send(c.id, 'retry')
    const args = calls[3].args
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 5)).toEqual([
      '--resume',
      's1',
      '--resume-session-at',
      'e1',
      '--fork-session'
    ])
    const meta = await store.get(c.id)
    expect(meta).toMatchObject({ sessionId: 's3' })
    expect(meta?.next).toBeUndefined()
  })

  it("switchVersion back sets next to the shown version's last end", async () => {
    const { c, second } = await stampedChat()
    scripts.push({ events: turnOf('s2', 'B2', 'f1') })
    await svc.rerun(c.id, second.id, 'two, edited')
    const v2 = (await itemsOf(c.id))[2]
    pushes.length = 0
    await svc.switchVersion(c.id, v2.id, 0)
    let items = await itemsOf(c.id)
    expect(items[2]).toMatchObject({ id: second.id, text: 'two', versions: { root: second.id, index: 0, count: 2 } })
    expect(items[3]).toMatchObject({ type: 'assistant', text: 'A2' })
    expect(await store.get(c.id)).toMatchObject({ sessionId: 's1', next: { at: 'e2' } })
    expect(pushes.map((p) => p.kind).sort()).toEqual(['items', 'meta'])
    await svc.switchVersion(c.id, second.id, 1)
    items = await itemsOf(c.id)
    expect(items[3]).toMatchObject({ type: 'assistant', text: 'B2' })
    expect(await store.get(c.id)).toMatchObject({ sessionId: 's2', next: { at: 'f1' } })
    // The next send on the shown version cuts at its end and forks.
    scripts.push({ events: turnOf('s4', 'C', 'k1') })
    await svc.send(c.id, 'three')
    expect(calls[3].args).toContain('--resume-session-at')
    expect(argAfter(calls[3], '--resume-session-at')).toBe('f1')
  })

  it('switchVersion to a version whose turn never recorded an end seeds the next send', async () => {
    const c = await store.create('helper', dir)
    await store.update(c.id, { sessionId: 'old' })
    await store.saveItems(c.id, [
      { type: 'user', id: 'u0', text: 'hello', ts: 1 },
      { type: 'assistant', id: 'a0', text: 'hi', ts: 2 }
    ])
    scripts.push({ events: turnOf('n1', 'new', 'h1') })
    await svc.rerun(c.id, 'u0', 'hello 2')
    const shown = (await itemsOf(c.id))[0]
    await svc.switchVersion(c.id, shown.id, 0)
    expect(await store.get(c.id)).toMatchObject({ sessionId: null, next: { seed: true } })
  })

  it("switchVersion in a room points every member at the shown version's ends and clears the queue", async () => {
    const c = await store.createGroup(['ui', 'wk', 'ps'], dir)
    const u0: ChatItem = { type: 'user', id: 'u0', text: 'hi', ts: 1 }
    const old: ChatItem[] = [
      u0,
      { type: 'assistant', id: 'a1', text: 'ui says', ts: 2, agent: 'ui', end: { agent: 'ui', session: 'sA', at: 'p1', seen: 'u0' } },
      { type: 'assistant', id: 'a2', text: 'wk says', ts: 3, agent: 'wk', end: { agent: 'wk', session: 'sB', at: 'q1', seen: 'a1' } }
    ]
    const b = branch(old, {}, 'u0', { type: 'user', id: 'u1', text: 'hi 2', ts: 4 })
    const shownNow: ChatItem[] = [
      ...b.items,
      { type: 'assistant', id: 'a3', text: 'new', ts: 5, agent: 'ui', end: { agent: 'ui', session: 'sC', at: 'r1', seen: 'u1' } }
    ]
    await store.saveItems(c.id, shownNow)
    await store.saveVersions(c.id, b.versions)
    await store.updateGroup(c.id, (g) => ({
      ...g,
      sessions: { ui: 'sC' },
      seen: { ui: 'u1' },
      next: { ps: { seed: true } },
      queue: [{ agent: 'wk', after: [] }],
      active: [{ agent: 'ps', turn: 't', since: 1 }]
    }))
    await svc.switchVersion(c.id, 'u1', 0)
    expect((await itemsOf(c.id)).map((i) => i.id)).toEqual(['u0', 'a1', 'a2'])
    expect((await store.get(c.id))?.group).toMatchObject({
      sessions: { ui: 'sA', wk: 'sB', ps: null },
      seen: { ui: 'u0', wk: 'a1', ps: null },
      next: { ui: { at: 'p1' }, wk: { at: 'q1' } },
      queue: [],
      active: []
    })
    expect(svc.isRunning(c.id)).toBe(false)
    expect(idled).toEqual([])
  })

  it('a failed versions save during rerun loses nothing: the old tail stays in the items', async () => {
    const { c, second } = await stampedChat()
    const before = await itemsOf(c.id)
    vi.spyOn(store, 'saveVersions').mockRejectedValueOnce(new Error('disk full'))
    await svc.rerun(c.id, second.id, 'two, edited')
    const items = await itemsOf(c.id)
    expect(items.slice(0, before.length)).toEqual(before)
    expect(items[items.length - 1]).toMatchObject({ type: 'error', text: 'disk full' })
    expect(await store.loadVersions(c.id)).toEqual({})
    expect(calls).toHaveLength(2)
    expect((await store.get(c.id))?.inFlight).toBe(false)
  })

  it('a rerun whose first items save fails restores the pre-branch list plus the error and keeps the session', async () => {
    const { c, second } = await stampedChat()
    const before = await itemsOf(c.id)
    const metaBefore = await store.get(c.id)
    vi.spyOn(store, 'saveItems').mockRejectedValueOnce(new Error('disk full'))
    await svc.rerun(c.id, second.id, 'two, edited')
    const items = await itemsOf(c.id)
    expect(items.slice(0, before.length)).toEqual(before)
    expect(items).toHaveLength(before.length + 1)
    expect(items[items.length - 1]).toMatchObject({ type: 'error', text: 'disk full' })
    const meta = await store.get(c.id)
    expect(meta?.sessionId).toBe(metaBefore?.sessionId)
    expect(meta?.next).toEqual(metaBefore?.next)
    expect(calls).toHaveLength(2)
  })

  it('an edit after a failed first edit stores two versions, not three, and shows 2 / 2', async () => {
    const { c, second } = await stampedChat()
    vi.spyOn(store, 'saveItems').mockRejectedValueOnce(new Error('disk full'))
    await svc.rerun(c.id, second.id, 'two, edited')
    scripts.push({ events: turnOf('s2', 'B2', 'f1') })
    await svc.rerun(c.id, second.id, 'two, again')
    const shown = (await itemsOf(c.id)).find((i) => i.type === 'user' && i.text === 'two, again')
    expect(shown).toMatchObject({ versions: { root: second.id, index: 1, count: 2 } })
    const list = (await store.loadVersions(c.id))[second.id].list
    expect(list).toHaveLength(2)
    const texts = list.flatMap((v) => (v ? [v.user.text] : []))
    expect(texts).toEqual(['two'])
    await svc.switchVersion(c.id, shown!.id, 0)
    expect((await itemsOf(c.id)).find((i) => i.type === 'user' && i.id === second.id)).toMatchObject({
      text: 'two',
      versions: { index: 0, count: 2 }
    })
  })

  it('a switch whose final versions save fails neither duplicates nor loses a version when switched again', async () => {
    const { c, second } = await stampedChat()
    scripts.push({ events: turnOf('s2', 'B2', 'f1') })
    await svc.rerun(c.id, second.id, 'two, edited')
    // A second rerun whose item save fails leaves a stale empty slot behind (the shown item keeps its old index).
    vi.spyOn(store, 'saveItems').mockRejectedValueOnce(new Error('disk full'))
    await svc.rerun(c.id, (await itemsOf(c.id))[2].id, 'two, again')
    const shown = (await itemsOf(c.id))[2]
    const root = shown.type === 'user' ? shown.versions!.root : ''
    expect((await store.loadVersions(c.id))[root].list).toHaveLength(3)
    const real = store.saveVersions.bind(store)
    let writes = 0
    // The switch writes versions twice: the safe copy (kept), then the final one (fails).
    vi.spyOn(store, 'saveVersions').mockImplementation(async (id, v) => {
      if (++writes === 2) throw new Error('disk full')
      return real(id, v)
    })
    await expect(svc.switchVersion(c.id, shown.id, 0)).rejects.toThrow('disk full')
    await svc.switchVersion(c.id, (await itemsOf(c.id))[2].id, 1)
    const versions = (await store.loadVersions(c.id))[root]
    const texts = [
      ...versions.list.flatMap((v) => (v ? [v.user.text] : [])),
      ((await itemsOf(c.id))[2] as Extract<ChatItem, { type: 'user' }>).text
    ]
    expect(versions.list).toHaveLength(2)
    expect(new Set(texts).size).toBe(texts.length)
    expect(texts.sort()).toEqual(['two', 'two, edited'])
  })

  it('a missing cut session whose seeded run also fails before init makes the next send reseed', async () => {
    const { c, second } = await stampedChat()
    scripts.push({ outcome: missing }, { outcome: { exitCode: 1, stderr: 'boom', result: null } })
    await svc.rerun(c.id, second.id, 'two, edited')
    expect(calls).toHaveLength(4)
    expect(await store.get(c.id)).toMatchObject({ sessionId: null, next: { seed: true } })
    scripts.push({ events: turnOf('n2', 'ok', 'k1') })
    await svc.send(c.id, 'retry')
    expect(calls[4].args).not.toContain('--resume')
    expect(calls[4].stdin).toContain('<earlier_conversation>')
    expect(calls[4].stdin).toContain('two, edited')
    const items = await itemsOf(c.id)
    expect(
      items.some(
        (i) =>
          i.type === 'notice' && i.kind === 'expired' && items.indexOf(i) > items.findIndex((x) => x.type === 'user' && x.text === 'retry')
      )
    ).toBe(true)
    const meta = await store.get(c.id)
    expect(meta).toMatchObject({ sessionId: 'n2' })
    expect(meta?.next).toBeUndefined()
  })

  it('whenIdle waits for a switch to finish', async () => {
    const { c, second } = await stampedChat()
    scripts.push({ events: turnOf('s2', 'B2', 'f1') })
    await svc.rerun(c.id, second.id, 'two, edited')
    const v2 = (await itemsOf(c.id))[2]
    const orig = store.saveVersions.bind(store)
    let open!: () => void
    const gate = new Promise<void>((r) => {
      open = r
    })
    vi.spyOn(store, 'saveVersions').mockImplementationOnce(async (id, v) => {
      await gate
      return orig(id, v)
    })
    idled.length = 0
    const p = svc.switchVersion(c.id, v2.id, 0)
    await tick()
    let idle = false
    const w = svc.whenIdle(c.id).then(() => {
      idle = true
    })
    await tick()
    expect(idle).toBe(false)
    open()
    await p
    await w
    expect(idle).toBe(true)
    expect(idled).toEqual([]) // a switch never wakes the task queue
    expect(svc.isRunning(c.id)).toBe(false)
  })

  it('switching to the version already shown writes nothing', async () => {
    const { c, second } = await stampedChat()
    scripts.push({ events: turnOf('s2', 'B2', 'f1') })
    await svc.rerun(c.id, second.id, 'two, edited')
    const v2 = (await itemsOf(c.id))[2]
    // As after a send that failed before init: the cut is still pending.
    await store.update(c.id, { sessionId: 's1', next: { at: 'e1' } })
    const meta = await store.get(c.id)
    const items = await itemsOf(c.id)
    const writes = [vi.spyOn(store, 'saveItems'), vi.spyOn(store, 'saveVersions'), vi.spyOn(store, 'update')]
    pushes.length = 0
    await svc.switchVersion(c.id, v2.id, 1)
    writes.forEach((w) => expect(w).not.toHaveBeenCalled())
    expect(pushes).toEqual([])
    expect(await store.get(c.id)).toEqual(meta)
    expect(await itemsOf(c.id)).toEqual(items)
  })

  // --resume-drops-turn: the cut names the turn it discards, so the CLI refuses one that would discard anything else.
  it("a cut declares the turn it discards, read off that message's own stamp", async () => {
    svc = makeService({ dropsTurn: async () => true })
    const { c, second } = await stampedChat()
    // The stamp rides beside the end stamp of the turn that answered the message.
    const stamped = (await itemsOf(c.id)).find((i) => i.end?.at === 'e2')!
    expect(stamped.sent?.session).toBe('s1')
    const prompt = stamped.sent!.at
    // It is the id that turn's own prompt went out under: without that the declaration would name nothing.
    expect(prompt).toBe(calls[1].stdinUuid)
    calls.length = 0
    scripts.push({ events: turnOf('s2', 'B2', 'f1') })
    await svc.rerun(c.id, second.id, 'two, edited')
    const spawn = calls[calls.length - 1]
    expect(argAfter(spawn, '--resume-session-at')).toBe('e1')
    expect(argAfter(spawn, '--resume-drops-turn')).toBe(prompt)
    // The prompt went out under that id, which is what makes the declaration mean anything.
    expect(spawn.stdinUuid).toBeTruthy()
  })

  it('names nothing when the binary does not take the flag', async () => {
    svc = makeService({ dropsTurn: async () => false })
    const { c, second } = await stampedChat()
    calls.length = 0
    scripts.push({ events: turnOf('s2', 'B2', 'f1') })
    await svc.rerun(c.id, second.id, 'two, edited')
    const spawn = calls[calls.length - 1]
    expect(spawn.args).toContain('--fork-session')
    expect(spawn.args).not.toContain('--resume-drops-turn')
  })

  it('a cut the CLI refuses reseeds, and is never sent again', async () => {
    svc = makeService({ dropsTurn: async () => true })
    const { c, second } = await stampedChat()
    calls.length = 0
    scripts.push(
      {
        outcome: {
          exitCode: 1,
          stderr:
            'Resume rejected by --resume-drops-turn: resuming at e1 would discard entries not attributable to turn p2: range does not start with the declared turn prompt',
          result: null
        }
      },
      { events: turnOf('s9', 'fresh', 'g1') }
    )
    await svc.rerun(c.id, second.id, 'two, edited')
    expect(calls).toHaveLength(2)
    expect(calls[0].args).toContain('--resume-drops-turn')
    // The recovery is a fresh session seeded from the visible items, never the same cut again and never a plain resume.
    expect(calls[1].args).not.toContain('--resume')
    expect(calls[1].args).not.toContain('--resume-drops-turn')
    expect(await store.get(c.id)).toMatchObject({ sessionId: 's9' })
  })

  it('switchVersion while running throws Chat is busy', async () => {
    const { c, second } = await stampedChat()
    scripts.push({ events: turnOf('s2', 'B2', 'f1') })
    await svc.rerun(c.id, second.id, 'two, edited')
    const v2 = (await itemsOf(c.id))[2]
    const up = hangUntilReady()
    const p = svc.send(c.id, 'busy')
    await up
    await tick()
    await expect(svc.switchVersion(c.id, v2.id, 0)).rejects.toThrow('Chat is busy')
    svc.stop(c.id)
    await p
  })

  it('whenIdle resolves after the running turn ends', async () => {
    const c = await store.create('helper', dir)
    const up = hangUntilReady()
    const p = svc.send(c.id, 'go')
    await up
    await tick()
    let idle = false
    const w = svc.whenIdle(c.id).then(() => {
      idle = true
    })
    await tick()
    expect(idle).toBe(false)
    svc.stop(c.id)
    await p
    await w
    expect(idle).toBe(true)
    await svc.whenIdle(c.id)
  })
})

describe('context meter and compact', () => {
  const result = (windows: Record<string, number>): RunEvent => ({ ...okResult, windows }) as RunEvent
  const turn = (extra: RunEvent[], windows: Record<string, number> = { m: 200_000, other: 1_000_000 }): RunEvent[] => [
    { kind: 'init', sessionId: 's1' },
    { kind: 'entry', uuid: 'e1' },
    { kind: 'assistantText', text: 'hi' },
    ...extra,
    result(windows)
  ]
  const compactRun = (pre = 900_000, post = 17_000): RunEvent[] => [
    { kind: 'compacting', on: true },
    { kind: 'compacting', on: false },
    { kind: 'init', sessionId: 's1' },
    { kind: 'compacted', pre, post },
    { kind: 'entry', uuid: 'c1' },
    { ...result({ m: 200_000 }), numTurns: 0 } as RunEvent
  ]
  const chatWithSession = async () => {
    const c = await store.create('helper', dir)
    scripts.push({ events: turn([{ kind: 'context', model: 'm', tokens: 50_000 }]) })
    await svc.send(c.id, 'one')
    return c
  }

  it('a turn saves how full the context is, with the window of the model that spoke and when its request ran', async () => {
    const c = await chatWithSession()
    const context = (await store.get(c.id))?.context
    expect(context).toEqual({ used: 50_000, window: 200_000, at: expect.any(Number) })
    expect(context!.at).toBeGreaterThan(1000) // the service's clock, at the request
  })

  it('a burst of requests is saved once, as the latest', async () => {
    const c = await store.create('helper', dir)
    const update = vi.spyOn(store, 'update')
    scripts.push({
      events: turn([
        { kind: 'context', model: 'm', tokens: 10 },
        { kind: 'context', model: 'm', tokens: 20 }
      ])
    })
    await svc.send(c.id, 'go')
    const saved = update.mock.calls.filter(([, patch]) => 'context' in patch).map(([, patch]) => patch.context)
    expect(saved).toEqual([{ used: 20, window: 200_000, at: expect.any(Number) }])
  })

  it('the window an earlier turn reported shows while the next turn runs', async () => {
    const c = await chatWithSession()
    const up = hangUntilReady([
        { kind: 'init', sessionId: 's1' },
        { kind: 'context', model: 'm', tokens: 70_000 }
    ])
    const p = svc.send(c.id, 'two')
    await up
    await tick()
    expect((await store.get(c.id))?.context).toEqual({ used: 70_000, window: 200_000, at: expect.any(Number) })
    svc.stop(c.id)
    await p
  })

  it('a compaction empties the meter until the next request, keeping the before and after', async () => {
    const c = await chatWithSession()
    scripts.push({ events: turn([{ kind: 'compacted', pre: 190_000, post: 9_000 }]) })
    await svc.send(c.id, 'two')
    expect((await store.get(c.id))?.context).toEqual({
      used: null,
      window: 200_000,
      compacted: { pre: 190_000, post: 9_000 },
      at: expect.any(Number)
    })
    scripts.push({ events: turn([{ kind: 'context', model: 'm', tokens: 40_000 }]) })
    await svc.send(c.id, 'three')
    expect((await store.get(c.id))?.context).toEqual({ used: 40_000, window: 200_000, at: expect.any(Number) })
  })

  it('shows compacting while the CLI compacts, and never once the turn ends', async () => {
    const c = await chatWithSession()
    const up = hangUntilReady([
        { kind: 'init', sessionId: 's1' },
        { kind: 'compacting', on: true }
    ])
    const p = svc.send(c.id, 'two')
    await up
    await tick()
    expect((await store.get(c.id))?.compacting).toBe(true)
    svc.stop(c.id)
    await p
    expect((await store.get(c.id))?.compacting).toBeUndefined()
  })

  it('compact runs /compact with the note on the chat session and adds no items', async () => {
    const c = await chatWithSession()
    const before = await itemsOf(c.id)
    scripts.push({ events: compactRun() })
    await svc.compact(c.id, 'keep the bug list')
    expect(calls[1].stdin).toBe('/compact keep the bug list')
    expect(argAfter(calls[1], '--resume')).toBe('s1')
    expect(await itemsOf(c.id)).toEqual(before)
    const meta = await store.get(c.id)
    expect(meta).toMatchObject({
      inFlight: false,
      sessionId: 's1',
      context: { used: null, window: 200_000, compacted: { pre: 900_000, post: 17_000 } }
    })
    expect(meta?.compacting).toBeUndefined()
    expect(idled).toContainEqual([c.id, false])
  })

  it('compact without a note sends a bare /compact, and a note stays on one line', async () => {
    const c = await chatWithSession()
    scripts.push({ events: compactRun() }, { events: compactRun() })
    await svc.compact(c.id, '  ')
    await svc.compact(c.id, ' keep\nthe  list ')
    expect(calls.slice(1).map((o) => o.stdin)).toEqual(['/compact', '/compact keep the list'])
  })

  it('compact marks the chat running and compacting while it works', async () => {
    const c = await chatWithSession()
    const up = hangUntilReady()
    const p = svc.compact(c.id, '')
    await up
    await tick()
    expect(svc.isRunning(c.id)).toBe(true)
    expect(await store.get(c.id)).toMatchObject({ inFlight: true, compacting: true })
    svc.stop(c.id)
    await p
    expect((await store.get(c.id))?.compacting).toBeUndefined()
  })

  it('compact cuts a session that must start at an earlier point', async () => {
    const c = await chatWithSession()
    await store.update(c.id, { next: { at: 'e0' } })
    scripts.push({ events: [...compactRun().slice(0, 2), { kind: 'init', sessionId: 's9' }, ...compactRun().slice(3)] })
    await svc.compact(c.id, '')
    expect(calls[1].args).toEqual(expect.arrayContaining(['--resume-session-at', 'e0', '--fork-session']))
    expect(await store.get(c.id)).toMatchObject({ sessionId: 's9' })
    expect((await store.get(c.id))?.next).toBeUndefined()
  })

  it('a fresh start (a routine set to start fresh) seeds a new session and says so, not that it expired', async () => {
    const c = await chatWithSession()
    await store.update(c.id, { next: { seed: true, fresh: true } })
    scripts.push({ events: pong })
    await svc.send(c.id, 'daily check')
    expect(calls[1].args).not.toContain('--resume')
    const notices = (await itemsOf(c.id)).filter((i) => i.type === 'notice')
    expect(notices.map((i) => i.type === 'notice' && i.kind)).toEqual(['fresh'])
    expect((await store.get(c.id))?.next).toBeUndefined()
  })

  it('compact refuses a chat with nothing to compact', async () => {
    const fresh = await store.create('helper', dir)
    await expect(svc.compact(fresh.id, '')).rejects.toThrow(NOTHING_TO_COMPACT)
    const seeded = await chatWithSession()
    await store.update(seeded.id, { next: { seed: true } })
    await expect(svc.compact(seeded.id, '')).rejects.toThrow(NOTHING_TO_COMPACT)
    expect(calls).toHaveLength(1)
    expect(svc.isRunning(fresh.id) || svc.isRunning(seeded.id)).toBe(false)
  })

  it('compact of a session that is gone shows the error and never seeds a new one', async () => {
    const c = await chatWithSession()
    scripts.push({ outcome: { exitCode: 1, stderr: 'No conversation found with session ID: s1', result: null } })
    await svc.compact(c.id, '')
    expect(calls).toHaveLength(2)
    const items = await itemsOf(c.id)
    expect(items.at(-1)).toMatchObject({ type: 'error', text: 'No conversation found with session ID: s1' })
    expect(await store.get(c.id)).toMatchObject({ sessionId: 's1', inFlight: false })
  })

  it('compact refuses a running chat and a group room', async () => {
    const c = await chatWithSession()
    const up = hangUntilReady()
    const p = svc.send(c.id, 'busy')
    await up
    await tick()
    await expect(svc.compact(c.id, '')).rejects.toThrow('Chat is already running')
    svc.stop(c.id)
    await p
    const g = await store.createGroup(['a', 'b'], dir)
    await expect(svc.compact(g.id, '')).rejects.toThrow('A group room compacts a member through the room')
  })

  it('an edit and a version switch clear the meter: it described the old version', async () => {
    const c = await chatWithSession()
    scripts.push({ events: turn([]) })
    await svc.send(c.id, 'two')
    const second = (await itemsOf(c.id))[2]
    scripts.push({ events: turn([]) })
    await svc.rerun(c.id, second.id, 'two, edited')
    expect((await store.get(c.id))?.context).toBeUndefined()
    await store.update(c.id, { context: { used: 5, window: 10 } })
    await svc.switchVersion(c.id, (await itemsOf(c.id))[2].id, 0)
    expect((await store.get(c.id))?.context).toBeUndefined()
  })
})

const argAfter = (o: RunOptions, flag: string) => o.args[o.args.indexOf(flag) + 1]

describe('turn-end signal', () => {
  let ends: TurnEnd[]
  beforeEach(() => {
    ends = []
    svc = makeService({ onTurnEnd: (e) => ends.push(e) })
  })

  it('reports ok once after a basic turn', async () => {
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'ping')
    expect(ends).toEqual([{ chatId: c.id, agent: 'helper', outcome: 'ok', reply: expect.any(String) }])
  })

  it('carries the reply text of the turn', async () => {
    const c = await store.create('helper', dir)
    scripts.push({ events: [{ kind: 'init', sessionId: 's1' }, { kind: 'assistantText', text: 'Hi' }, okResult] })
    await svc.send(c.id, 'ping')
    expect(ends.map((e) => e.reply)).toEqual(['Hi'])
  })

  it('reports error for an error result', async () => {
    const c = await store.create('helper', dir)
    scripts.push({ outcome: { exitCode: 1, stderr: 'boom', result: null } })
    await svc.send(c.id, 'ping')
    expect(ends).toEqual([{ chatId: c.id, agent: 'helper', outcome: 'error', reply: expect.any(String) }])
  })

  it('reports stopped after stop()', async () => {
    const c = await store.create('helper', dir)
    const up = hangUntilReady()
    const p = svc.send(c.id, 'ping')
    await up
    await tick()
    svc.stop(c.id)
    await p
    expect(ends).toEqual([{ chatId: c.id, agent: 'helper', outcome: 'stopped', reply: expect.any(String) }])
  })

  it('does not report a compact run', async () => {
    const c = await store.create('helper', dir)
    scripts.push({ events: [{ kind: 'init', sessionId: 's1' }, { kind: 'assistantText', text: 'hi' }, okResult] })
    await svc.send(c.id, 'one')
    ends.length = 0
    scripts.push({
      events: [{ kind: 'compacting', on: true }, { kind: 'compacting', on: false }, { kind: 'init', sessionId: 's1' }, okResult]
    })
    await svc.compact(c.id, '')
    expect(ends).toEqual([])
  })

  it('leaves the turn result alone when the hook throws', async () => {
    const c = await store.create('helper', dir)
    svc = makeService({
      onTurnEnd: () => {
        throw new Error('hook broke')
      }
    })
    await expect(svc.send(c.id, 'ping')).resolves.not.toThrow()
    const items = await itemsOf(c.id)
    expect(items.map((i) => i.type)).toEqual(['user', 'assistant'])
    expect((await store.get(c.id))?.inFlight).toBe(false)
  })

  it('names the approvals push after the agent', async () => {
    const c = await store.create('helper', dir)
    const up = hangUntilReady([
        {
          kind: 'permissionRequest',
          requestId: 'r1',
          toolName: 'Bash',
          input: { command: 'ls' },
          description: 'd',
          reason: 'r',
          toolUseId: null
        }
    ])
    const p = svc.send(c.id, 'go')
    await up
    await tick()
    expect(pushes.filter((x) => x.kind === 'approvals')).toEqual([{ chatId: c.id, kind: 'approvals', pending: 1, agent: 'helper' }])
    svc.stop(c.id)
    await p
  })

  describe('agent memory', () => {
    let mem: string
    let begun: string[]
    let ended: [string, boolean][]
    let note: string | null
    let beginThrows: boolean
    beforeEach(async () => {
      mem = join(dir, 'mem', 'helper')
      await fs.mkdir(mem, { recursive: true })
      begun = []
      ended = []
      note = 'CAP NOTE'
      beginThrows = false
      svc = makeService({
        memory: {
          begin: async (a) => {
            begun.push(a)
            if (beginThrows) throw new Error('boom')
            return note === null ? null : { dir: mem, note }
          },
          end: (a, t) => {
            ended.push([a, t])
          }
        }
      })
    })
    const use = (id: string, name: string, file: string): RunEvent =>
      ({ kind: 'toolUse', id, name, input: { file_path: file } }) as RunEvent
    const done = (id: string, isError = false): RunEvent => ({ kind: 'toolResult', toolUseId: id, content: 'x', isError }) as RunEvent
    const turn = async (events: RunEvent[]) => {
      scripts.push({ events: [...events, { kind: 'assistantText', text: 'bye' } as RunEvent, okResult] })
      const c = await store.create('helper', dir)
      await svc.send(c.id, 'go')
      return itemsOf(c.id)
    }
    const memoryOf = (items: ChatItem[]) => items.filter((i) => 'memory' in i && i.memory)

    it('adds the note after house style, nothing when begin gives null, never for compact', async () => {
      style = true
      await turn([])
      const a = calls[0].args
      expect(a[a.indexOf('--append-system-prompt') + 1]).toBe(`${HOUSE_STYLE}\n\nCAP NOTE`)
      expect(begun).toEqual(['helper'])
      note = null
      style = false
      const c = await store.create('helper', dir)
      await svc.send(c.id, 'x')
      expect(calls[1].args).not.toContain('--append-system-prompt')
      const before = begun.length
      await svc.compact(c.id, '').catch(() => {})
      expect(begun.length).toBe(before)
    })

    it('a begin that throws still runs the turn, and end still balances it', async () => {
      beginThrows = true
      const items = await turn([])
      expect(items.some((i) => i.type === 'assistant')).toBe(true)
      expect(ended).toEqual([['helper', false]])
    })

    it('a new file written counts as saved on the last assistant/tool item', async () => {
      const items = await turn([use('t1', 'Write', join(mem, 'user_x.md')), done('t1')])
      expect(memoryOf(items)).toHaveLength(1)
      const last = items.filter((i) => i.type === 'assistant' || i.type === 'tool').at(-1)!
      expect((last as { memory?: unknown }).memory).toEqual({ saved: 1, updated: 0 })
      expect(ended).toEqual([['helper', true]])
    })

    it('an edit of an existing file counts as updated', async () => {
      await fs.writeFile(join(mem, 'a.md'), 'x')
      const items = await turn([use('t1', 'Edit', join(mem, 'a.md')), done('t1')])
      expect(memoryOf(items)[0]).toMatchObject({ memory: { saved: 0, updated: 1 } })
    })

    it('written then edited in one turn counts once as saved', async () => {
      const f = join(mem, 'n.md')
      const items = await turn([use('t1', 'Write', f), done('t1'), use('t2', 'MultiEdit', f), done('t2')])
      expect(memoryOf(items)[0]).toMatchObject({ memory: { saved: 1, updated: 0 } })
    })

    it('ignores the index, other folders, escapes, subfolders, errors and other tools', async () => {
      const items = await turn([
        use('a', 'Write', join(mem, 'MEMORY.md')),
        done('a'),
        use('b', 'Write', join(dir, 'mem', 'other', 'x.md')),
        done('b'),
        use('c', 'Write', join(mem, '..', 'other', 'x.md')),
        done('c'),
        use('d', 'Write', join(mem, 'sub', 'x.md')),
        done('d'),
        use('e', 'Write', join(mem, 'err.md')),
        done('e', true),
        use('f', 'Read', join(mem, 'r.md')),
        done('f')
      ])
      expect(memoryOf(items)).toHaveLength(0)
      expect(ended).toEqual([['helper', false]])
    })

    it('end runs once even when the turn throws, with the spawned name after a rename', async () => {
      const up = hangUntilReady([use('t1', 'Write', join(mem, 'u.md'))])
      const c = await store.create('helper', dir)
      const p = svc.send(c.id, 'go')
      await up
      await tick()
      svc.renameAgent('helper', 'renamed')
      emit(done('t1'))
      svc.stop(c.id)
      await p
      expect(begun).toEqual(['helper'])
      expect(ended).toEqual([['helper', true]])
    })

    it('end runs when the store fails while saving', async () => {
      const c = await store.create('helper', dir)
      const real = store.saveItems.bind(store)
      let calls2 = 0
      const spy = vi.spyOn(store, 'saveItems').mockImplementation(async (...a) => {
        if (++calls2 > 1) throw new Error('disk')
        return real(...a)
      })
      await svc.send(c.id, 'go').catch(() => {})
      spy.mockRestore()
      expect(ended).toHaveLength(1)
    })
  })
})

describe('file changes', () => {
  let snaps: SnapshotStore
  const text = async (chatId: string, id: string | null) => (id === null ? null : snaps.read(chatId, id))
  const editEvents = (file: string): RunEvent[] => [
    { kind: 'init', sessionId: 's1' },
    { kind: 'toolUse', id: 'e1', name: 'Edit', input: { file_path: file, old_string: 'two', new_string: 'TWO' } },
    {
      kind: 'toolResult',
      toolUseId: 'e1',
      content: 'ok',
      isError: false,
      detail: { filePath: file, oldString: 'two', newString: 'TWO', originalFile: 'one\ntwo\n', replaceAll: false }
    },
    okResult
  ]
  const agentEvents = (file: string): RunEvent[] => [
    { kind: 'init', sessionId: 's1' },
    { kind: 'toolUse', id: 'ag', name: 'Agent', input: { prompt: 'edit it' } },
    {
      kind: 'subToolUse',
      parent: 'ag',
      id: 's1',
      name: 'Edit',
      input: { file_path: file, old_string: 'two', new_string: 'TWO' },
      subagent: 'general-purpose'
    },
    { kind: 'subToolResult', parent: 'ag', toolUseId: 's1', content: 'ok', isError: false },
    { kind: 'toolResult', toolUseId: 'ag', content: 'done', isError: false },
    okResult
  ]
  const withTracking = (extra: Partial<ChatServiceDeps> = {}) => {
    svc = makeService({ snapshots: snaps, readFile: async (p) => fs.readFile(p), ...extra })
  }
  beforeEach(() => {
    snaps = new SnapshotStore(join(dir, 'snap'))
  })

  it('an Edit result becomes a change with both copies on the tool item', async () => {
    withTracking()
    const c = await store.create('helper', dir)
    scripts.push({ events: editEvents(join(dir, 'a.txt')) })
    await svc.send(c.id, 'go')
    const tool = (await itemsOf(c.id)).find((i) => i.type === 'tool')
    if (tool?.type !== 'tool') throw new Error('no tool item')
    expect(tool.changes).toHaveLength(1)
    const ch = tool.changes![0]
    expect(ch).toMatchObject({ id: 'e1', path: join(dir, 'a.txt'), op: 'update' })
    expect(ch.subagent).toBeUndefined()
    expect(await text(c.id, ch.before)).toBe('one\ntwo\n')
    expect(await text(c.id, ch.after)).toBe('one\nTWO\n')
  })

  it('one Codex ApplyPatch result with three changes stores three changes on its tool item', async () => {
    withTracking()
    const c = await store.create('helper', dir)
    await fs.writeFile(join(dir, 'a.txt'), 'line one\nline TWO changed\nline three\n')
    const changes = [
      {
        path: join(dir, 'a.txt'),
        kind: 'update',
        movePath: null,
        diff: '@@ -1,3 +1,3 @@\n line one\n-line two\n+line TWO changed\n line three\n'
      },
      { path: join(dir, 'b.txt'), kind: 'add', movePath: null, diff: 'brand new\n' },
      { path: join(dir, 'c.txt'), kind: 'delete', movePath: null, diff: 'to be deleted\n' }
    ]
    scripts.push({
      events: [
        { kind: 'init', sessionId: 's1' },
        { kind: 'toolUse', id: 'p1', name: 'ApplyPatch', input: { changes: changes.map(({ path, kind }) => ({ path, kind })) } },
        { kind: 'toolResult', toolUseId: 'p1', content: 'ok', isError: false, detail: { codexChanges: changes } },
        okResult
      ]
    })
    await svc.send(c.id, 'go')
    const tool = (await itemsOf(c.id)).find((i) => i.type === 'tool')
    if (tool?.type !== 'tool') throw new Error('no tool item')
    expect(tool.changes?.map((x) => x.path)).toEqual([join(dir, 'a.txt'), join(dir, 'b.txt'), join(dir, 'c.txt')])
    expect(await text(c.id, tool.changes![0].before)).toBe('line one\nline two\nline three\n')
    expect(await text(c.id, tool.changes![1].after)).toBe('brand new\n')
    expect(await text(c.id, tool.changes![2].before)).toBe('to be deleted\n')
  })

  it('a subagent Edit lands on the Agent item and its text never becomes items', async () => {
    await fs.writeFile(join(dir, 'a.txt'), 'one\nTWO\n')
    withTracking()
    const c = await store.create('helper', dir)
    scripts.push({ events: agentEvents('a.txt') })
    await svc.send(c.id, 'go')
    const items = await itemsOf(c.id)
    expect(items.map((i) => i.type)).toEqual(['user', 'tool'])
    const tool = items[1]
    if (tool.type !== 'tool') throw new Error('no tool item')
    expect(tool.changes).toHaveLength(1)
    expect(tool.changes![0]).toMatchObject({ id: 's1', path: join(dir, 'a.txt'), subagent: 'general-purpose' })
    expect(await text(c.id, tool.changes![0].before)).toBe('one\ntwo\n')
    expect(await text(c.id, tool.changes![0].after)).toBe('one\nTWO\n')
  })

  it('a failed Edit records nothing', async () => {
    withTracking()
    const c = await store.create('helper', dir)
    const evs = editEvents(join(dir, 'a.txt'))
    evs[2] = { ...(evs[2] as Extract<RunEvent, { kind: 'toolResult' }>), isError: true }
    scripts.push({ events: evs })
    await svc.send(c.id, 'go')
    const tool = (await itemsOf(c.id)).find((i) => i.type === 'tool')
    expect(tool).toMatchObject({ isError: true })
    expect(tool && 'changes' in tool ? tool.changes : undefined).toBeUndefined()
  })

  it('a failing readFile and a failing snapshot put never change how the turn ends', async () => {
    const put = vi.fn().mockRejectedValue(new Error('disk full'))
    withTracking({
      snapshots: { put, read: async () => null },
      readFile: async () => {
        throw new Error('EACCES')
      }
    })
    const c = await store.create('helper', dir)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      scripts.push({ events: editEvents(join(dir, 'a.txt')) }, { events: agentEvents('a.txt') })
      await svc.send(c.id, 'one')
      await svc.send(c.id, 'two')
      const items = await itemsOf(c.id)
      expect(items.some((i) => i.type === 'error')).toBe(false)
      // The Edit lost its copies (the store failed) so it has no change; the Agent's keeps what it knows, the strings.
      const [edit, agent] = items.filter((i) => i.type === 'tool')
      expect(edit && 'changes' in edit ? edit.changes : undefined).toBeUndefined()
      expect(agent && 'changes' in agent ? agent.changes : undefined).toMatchObject([
        { before: null, after: null, why: { after: 'unreadable' }, snippet: { old: 'two', new: 'TWO' } }
      ])
      expect((await store.get(c.id))?.inFlight).toBe(false)
      const logged = JSON.stringify(log.mock.calls)
      expect(logged).not.toContain('disk full')
      expect(logged).not.toContain('EACCES')
    } finally {
      log.mockRestore()
    }
  })

  it('a stop while a subagent read is pending still ends idle, with a stopped notice and no error', async () => {
    let release: (b: Buffer) => void = () => {}
    const read = new Promise<Buffer>((r) => {
      release = r
    })
    const readFile = vi.fn(() => read)
    withTracking({ readFile })
    const c = await store.create('helper', dir)
    const up = hangUntilReady(agentEvents('a.txt').slice(0, 4))
    const p = svc.send(c.id, 'go')
    await up
    await tick()
    expect(readFile).toHaveBeenCalled() // the read is in flight when the stop comes
    svc.stop(c.id)
    release(Buffer.from('one\nTWO\n'))
    await p
    const items = await itemsOf(c.id)
    expect(items.some((i) => i.type === 'error')).toBe(false)
    expect(items[items.length - 1]).toMatchObject({ type: 'notice', kind: 'stopped' })
    expect((await store.get(c.id))?.inFlight).toBe(false)
    expect(svc.isRunning(c.id)).toBe(false)
  })

  it('a copy still being written when the chat is deleted never recreates its folder', async () => {
    let release: (b: Buffer) => void = () => {}
    const read = new Promise<Buffer>((r) => {
      release = r
    })
    const readFile = vi.fn(() => read)
    withTracking({ readFile })
    const c = await store.create('helper', dir)
    const up = hangUntilReady(agentEvents('a.txt').slice(0, 4))
    const p = svc.send(c.id, 'go')
    await up
    await tick()
    expect(readFile).toHaveBeenCalled() // the tracker's put has not run yet
    svc.stop(c.id)
    await store.remove(c.id)
    await snaps.removeChat(c.id) // what chats:remove does
    release(Buffer.from('one\nTWO\n'))
    await p
    await tick()
    const left = await fs.readdir(join(dir, 'snap')).catch(() => [] as string[])
    expect(left).not.toContain(c.id)
  })

  it('without snapshots in the deps nothing is tracked', async () => {
    svc = makeService()
    const c = await store.create('helper', dir)
    scripts.push({ events: editEvents(join(dir, 'a.txt')) })
    await svc.send(c.id, 'go')
    const tool = (await itemsOf(c.id)).find((i) => i.type === 'tool')
    expect(tool).toMatchObject({ name: 'Edit', result: 'ok' })
    expect(tool && 'changes' in tool ? tool.changes : undefined).toBeUndefined()
  })

  it('browser tools never reach the tracker', async () => {
    const readFile = vi.fn().mockResolvedValue(Buffer.from(''))
    withTracking({ readFile })
    const c = await store.create('helper', dir)
    scripts.push({
      events: [
        { kind: 'toolUse', id: 'b1', name: 'mcp__zumibot_browser__Edit', input: {} },
        { kind: 'toolResult', toolUseId: 'b1', content: 'x', isError: false, detail: { filePath: 'a', originalFile: 'a' } },
        okResult
      ]
    })
    await svc.send(c.id, 'go')
    const tool = (await itemsOf(c.id)).find((i) => i.type === 'tool')
    expect(tool && 'changes' in tool ? tool.changes : undefined).toBeUndefined()
    expect(readFile).not.toHaveBeenCalled()
  })
})

describe('side questions: spawn capture and fork point', () => {
  it('keeps the current start active while the next spawn is being prepared', async () => {
    const create = vi.fn(async () => ({ mcp: NO_MCP, args: [] as string[], env: {}, prompt: '', dispose: async () => {} }))
    svc = makeService({ browserTurns: { profileId: async () => 'profile', create } })
    const c = await store.create('helper', dir)
    scripts.push({ events: [{ kind: 'init', sessionId: 'S' }, { kind: 'entry', uuid: 'end' }, okResult] })
    await svc.send(c.id, 'first')
    let resume!: () => void
    const pending = new Promise<void>((resolve) => {
      resume = resolve
    })
    create.mockImplementationOnce(async () => {
      await pending
      return { mcp: NO_MCP, args: [], env: {}, prompt: '', dispose: async () => {} }
    })
    scripts.push({ hang: true, events: [] })
    const done = svc.send(c.id, 'second')
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    expect(svc.sideBase(c.id, 'helper')).toMatchObject({ active: true, live: null, start: { session: 'S', at: 'end' } })
    svc.stop(c.id)
    resume()
    await done
    expect(svc.sideBase(c.id, 'helper')?.active).toBe(false)
  })

  it('marks capture active during the turn and idle after stopping', async () => {
    const c = await store.create('helper', dir)
    scripts.push({ hang: true, events: [] })
    const done = svc.send(c.id, 'go')
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(svc.sideBase(c.id, 'helper')?.active).toBe(true)
    svc.stop(c.id)
    await done
    expect(svc.sideBase(c.id, 'helper')?.active).toBe(false)
  })

  it('a missing-session retry captures an active seed instead of the expired start', async () => {
    const c = await store.create('helper', dir)
    await store.update(c.id, { sessionId: 'gone' })
    await store.saveItems(c.id, [{ type: 'assistant', id: 'a', text: 'old', ts: 1, end: { session: 'gone', at: 'old-at' } }])
    scripts.push({ events: [], outcome: { result: null, stderr: 'No conversation found with session ID gone', exitCode: 1 } })
    scripts.push({ hang: true, events: [] })
    const done = svc.send(c.id, 'go')
    // The missing-session path crosses disk writes before its second spawn.
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(svc.sideBase(c.id, 'helper')).toMatchObject({ active: true, live: null, start: null })
    svc.stop(c.id)
    await done
  })

  it('sideBase is null before any turn', async () => {
    const c = await store.create('helper', dir)
    expect(svc.sideBase(c.id, 'helper')).toBeNull()
  })

  it('sideBase mirrors the spawn args', async () => {
    style = true
    const c = await store.create('zumi-bot', dir)
    scripts.push({
      events: [{ kind: 'init', sessionId: 's1' }, { kind: 'entry', uuid: 'e1' }, { kind: 'assistantText', text: 'hi' }, okResult]
    })
    await svc.send(c.id, 'one')
    const b = svc.sideBase(c.id, 'zumi-bot')!
    expect(b).toMatchObject({ bin: '/bin/claude', cwd: dir, browser: false, live: null })
    expect(b.args.appendSystemPrompt).toContain(HOUSE_STYLE)
    const args = calls[0].args
    expect(b.args.agentName).toBe(args[args.indexOf('--agent') + 1])
    expect(b.args.permissionMode).toBe(args[args.indexOf('--permission-mode') + 1])
    expect(b.args.disallowedTools).toEqual(args.slice(args.indexOf('--disallowedTools') + 1))
    expect(b.args.extraArgs).toEqual([])
    // Only the session part differs from what the agent's own runs get.
    expect(buildArgs({ ...b.args, resumeSessionId: null })).toEqual(calls[0].args)
    await svc.send(c.id, 'two')
    expect(buildArgs({ ...svc.sideBase(c.id, 'zumi-bot')!.args, resumeSessionId: 's1' })).toEqual(calls[1].args)
  })

  it('sideBase leaves the browser parts out and sideBrowser makes the same turn', async () => {
    svc = makeService({ browserTurns: { profileId: async () => null, create: vi.fn() } })
    const c = await store.create('helper', dir)
    expect(await svc.sideBrowser(c.id, 'helper')).toMatchObject({ args: ['--no-chrome'] })
    await svc.send(c.id, 'hello')
    const b = svc.sideBase(c.id, 'helper')!
    expect(b.browser).toBe(true)
    expect(b.args.extraArgs).not.toContain('--no-chrome')
    expect(b.args.appendSystemPrompt).toBe('')
    const turn = (await svc.sideBrowser(c.id, 'helper'))!
    const appendSystemPrompt = [b.args.appendSystemPrompt, turn.prompt].filter(Boolean).join('\n\n')
    expect(buildArgs({ ...b.args, resumeSessionId: null, extraArgs: [...b.args.extraArgs, ...turn.args], appendSystemPrompt })).toEqual(
      calls[0].args
    )
    expect(await makeService().sideBrowser(c.id, 'helper')).toBeNull()
  })

  it('sideBrowser makes a fresh browser capability without adding handoff cards', async () => {
    const owners: BrowserOwner[] = []
    svc = makeService({
      browserTurns: {
        profileId: async (agent, chatId) => (agent === 'helper' && chatId === c.id ? 'profile' : null),
        create: async (owner, onHandoff) => {
          owners.push(owner)
          await onHandoff({
            ...owner,
            id: 'handoff',
            generation: 'gen',
            agent: 'helper',
            site: 'example.test',
            reason: 'Sign in',
            createdAt: 1,
            status: 'pending'
          })
          return {
            mcp: NO_MCP,
            args: ['--mcp-config', 'browser-config'],
            env: { ZUMIBOT_BROWSER_CAPABILITY: owner.turnId },
            prompt: 'Browser prompt',
            dispose: async () => {}
          }
        }
      }
    })
    const c = await store.create('helper', dir)
    const first = await svc.sideBrowser(c.id, 'helper')
    const second = await svc.sideBrowser(c.id, 'helper')
    expect(first?.args).toEqual(['--mcp-config', 'browser-config'])
    expect(first?.prompt).toBe('Browser prompt')
    expect(first?.env.ZUMIBOT_BROWSER_CAPABILITY).not.toBe(second?.env.ZUMIBOT_BROWSER_CAPABILITY)
    expect(owners).toHaveLength(2)
    expect(owners[0]).toMatchObject({ chatId: c.id, profileId: 'profile' })
    expect(await itemsOf(c.id)).toEqual([])
    expect(pushes).toEqual([])
    expect(svc.pendingCount(c.id)).toBe(0)
    await first?.dispose()
    await second?.dispose()
  })

  it('live point follows clean entries while running', async () => {
    const c = await store.create('helper', dir)
    scripts.push({
      hang: true,
      events: [
        { kind: 'init', sessionId: 'S' },
        { kind: 'entry', uuid: 'e1' },
        { kind: 'assistantText', text: 'looking' },
        { kind: 'entry', uuid: 'e2' },
        { kind: 'toolUse', id: 't1', name: 'Bash', input: {} }
      ]
    })
    const p = svc.send(c.id, 'go')
    await vi.waitFor(() => expect(svc.sideBase(c.id, 'helper')?.live).toEqual({ session: 'S', at: 'e1' }))
    emit({ kind: 'entry', uuid: 'e3' })
    emit({ kind: 'toolResult', toolUseId: 't1', content: 'ok', isError: false })
    expect(svc.sideBase(c.id, 'helper')!.live).toEqual({ session: 'S', at: 'e3' })
    svc.stop(c.id)
    await p
    expect(svc.sideBase(c.id, 'helper')!.live).toBeNull()
  })

  it('start is the previous end before the first clean entry', async () => {
    const c = await store.create('helper', dir)
    await store.update(c.id, { sessionId: 'S0' })
    await store.saveItems(c.id, [
      { type: 'user', id: 'u0', text: 'hi', ts: 1 },
      { type: 'assistant', id: 'a0', text: 'hello', ts: 2, end: { session: 'S0', at: 'x' } }
    ])
    scripts.push({ hang: true, events: [{ kind: 'init', sessionId: 'S0' }] })
    const p = svc.send(c.id, 'go')
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].args).toContain('S0')
    const b = svc.sideBase(c.id, 'helper')!
    expect(b.live).toBeNull()
    expect(b.start).toEqual({ session: 'S0', at: 'x' })
    svc.stop(c.id)
    await p
  })

  it('renaming the agent moves its side base', async () => {
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'one')
    svc.renameAgent('helper', 'aide')
    expect(svc.sideBase(c.id, 'helper')).toBeNull()
    expect(svc.sideBase(c.id, 'aide')?.args.agentName).toBe('aide')
  })

  it('a live side base follows a rename through later entries and completion', async () => {
    const c = await store.create('helper', dir)
    scripts.push({
      hang: true,
      events: [
        { kind: 'init', sessionId: 'S' },
        { kind: 'entry', uuid: 'e1' }
      ]
    })
    const done = svc.send(c.id, 'go')
    await vi.waitFor(() => expect(svc.sideBase(c.id, 'helper')?.live).toEqual({ session: 'S', at: 'e1' }))
    svc.renameAgent('helper', 'aide')
    emit({ kind: 'entry', uuid: 'e2' })
    expect(svc.sideBase(c.id, 'helper')).toBeNull()
    expect(svc.sideBase(c.id, 'aide')?.live).toEqual({ session: 'S', at: 'e2' })
    svc.stop(c.id)
    await done
    expect(svc.sideBase(c.id, 'aide')?.live).toBeNull()
  })

  it('an explicit cut takes precedence over the previous end', async () => {
    const c = await store.create('helper', dir)
    await store.update(c.id, { sessionId: 'S0', next: { at: 'cut' } })
    await store.saveItems(c.id, [{ type: 'assistant', id: 'a0', text: 'old', ts: 1, end: { session: 'S0', at: 'later' } }])
    scripts.push({ hang: true, events: [] })
    const done = svc.send(c.id, 'go')
    // Capture follows asynchronous item/session writes.
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(svc.sideBase(c.id, 'helper')?.start).toEqual({ session: 'S0', at: 'cut' })
    expect(svc.sideBase(c.id, 'helper')?.live).toBeNull()
    svc.stop(c.id)
    await done
  })

  it('start uses only this room member and session', async () => {
    const c = await store.create('helper', dir)
    let items: ChatItem[] = [
      { type: 'assistant', id: 'a0', text: 'own', ts: 1, end: { session: 'S0', at: 'own', agent: 'helper', seen: 'u0' } },
      { type: 'assistant', id: 'a1', text: 'other', ts: 2, end: { session: 'S0', at: 'other', agent: 'other', seen: 'u0' } },
      { type: 'assistant', id: 'a2', text: 'wrong session', ts: 3, end: { session: 'S1', at: 'wrong', agent: 'helper', seen: 'u0' } }
    ]
    const running = svc.claim(c.id)
    await svc.agentTurn(
      c.id,
      running,
      {
        agentName: 'helper',
        author: 'helper',
        sessionId: 'S0',
        prompt: 'go',
        seedPrompt: () => 'seed',
        extraArgs: ['--add-dir', '/shared'],
        disallowedTools: [],
        systemPrompt: 'Room briefing',
        allowScope: 'scope',
        saveSession: async () => {}
      },
      {
        get: () => items,
        set: (next) => {
          items = next
        }
      }
    )
    expect(svc.sideBase(c.id, 'helper')?.start).toEqual({ session: 'S0', at: 'own' })
    expect(svc.sideBase(c.id, 'helper')?.args).toMatchObject({ extraArgs: ['--add-dir', '/shared'], appendSystemPrompt: 'Room briefing' })
    svc.release(c.id, running)
  })
})

describe('chat to-dos', () => {
  const TODO_CONFIG = '{"mcpServers":{"zumibot_todos":{"type":"stdio"}}}'
  const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1]
  let todos: TodoService
  let made: TodoOwner[]
  let order: string[]
  let tn: number
  const todoTurns = () => ({
    create: (owner: TodoOwner): TodoTurn => {
      made.push(owner)
      order.push('create')
      return {
        mcp: NO_MCP,
        args: ['--mcp-config', TODO_CONFIG],
        env: { ZUMIBOT_TODOS_CAPABILITY: `todo-cap-${made.length}`, ZUMIBOT_TODOS_IPC: '/tmp/private-todo-ipc' },
        dispose: () => {
          order.push('dispose')
        }
      }
    }
  })
  // What the agent's bridge does on an `add`: the service call under the attempt's own owner.
  const agentAdds =
    (...texts: string[]) =>
    async () => {
      const o = made.at(-1)!
      await todos.agentAdd(
        o.chatId,
        o.agent(),
        o.turn,
        o.label,
        texts.map((text) => ({ text }))
      )
    }
  const todoUse = (id: string, tool = 'add'): RunEvent[] => [
    { kind: 'toolUse', id, name: `mcp__zumibot_todos__${tool}`, input: {} },
    { kind: 'toolResult', toolUseId: id, content: 'Added.', isError: false }
  ]
  const todoFile = (chatId: string) => join(dir, 'chats', `${chatId}.todos.json`)
  // The agent saw the list as it is now.
  const seeNow = async (chatId: string) => todos.markSeen(chatId, 'helper', (await todos.list(chatId)).rev)
  beforeEach(() => {
    made = []
    order = []
    tn = 0
    todos = new TodoService({ store, now: () => 5000 + tn, newId: () => `td${++tn}`, onChanged: () => {} })
    svc = makeService({ todos, todoTurns: todoTurns() })
  })

  it('adds TODO_SYSTEM and the to-do mcp args on every attempt, also when the agent never used them', async () => {
    const c = await store.create('helper', dir)
    await store.update(c.id, { sessionId: 'old' })
    scripts.push({ outcome: { result: null, stderr: 'No conversation found with session ID: old' } }, { events: pong })
    await svc.send(c.id, 'go')
    await svc.send(c.id, 'again')
    expect(calls).toHaveLength(3)
    for (const call of calls) {
      expect(argAfter(call.args, '--mcp-config')).toBe(TODO_CONFIG)
      expect(argAfter(call.args, '--append-system-prompt')).toContain(TODO_SYSTEM)
      expect(call.env?.ZUMIBOT_TODOS_CAPABILITY).toMatch(/^todo-cap-\d$/)
    }
    expect(new Set(calls.map((call) => call.env?.ZUMIBOT_TODOS_CAPABILITY)).size).toBe(3)
    // One key per logical turn: the reseed retry adds to the same touch; the next message is a new turn.
    expect(made[1].turn).toBe(made[0].turn)
    expect(made[2].turn).not.toBe(made[0].turn)
    expect(made[0]).toMatchObject({ chatId: c.id, label: 'go' })
    expect(made[0].agent()).toBe('helper')
    expect(order).toEqual(['create', 'dispose', 'create', 'dispose', 'create', 'dispose'])
  })

  it('puts the browser args first, merges the env, and side runs get the same args', async () => {
    svc = makeService({
      todos,
      todoTurns: todoTurns(),
      browserTurns: {
        profileId: async () => 'profile',
        create: async () => ({
          mcp: NO_MCP,
          args: ['--mcp-config', 'browser-config'],
          env: { ZUMIBOT_BROWSER_CAPABILITY: 'browser-cap' },
          prompt: 'Browser prompt',
          dispose: async () => {
            order.push('browser-dispose')
          }
        })
      }
    })
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'hello')
    const args = calls[0].args
    expect(args.indexOf('browser-config')).toBeGreaterThan(-1)
    expect(args.indexOf('browser-config')).toBeLessThan(args.indexOf(TODO_CONFIG))
    expect(calls[0].env).toMatchObject({ ZUMIBOT_BROWSER_CAPABILITY: 'browser-cap', ZUMIBOT_TODOS_CAPABILITY: 'todo-cap-1' })
    const b = svc.sideBase(c.id, 'helper')!
    expect(b.browser).toBe(true)
    expect(b.args.extraArgs).toEqual([])
    const turn = (await svc.sideBrowser(c.id, 'helper'))!
    const appendSystemPrompt = [b.args.appendSystemPrompt, turn.prompt].filter(Boolean).join('\n\n')
    expect(buildArgs({ ...b.args, resumeSessionId: null, extraArgs: [...b.args.extraArgs, ...turn.args], appendSystemPrompt })).toEqual(
      calls[0].args
    )
    expect(turn.env).toMatchObject({ ZUMIBOT_BROWSER_CAPABILITY: 'browser-cap', ZUMIBOT_TODOS_CAPABILITY: 'todo-cap-2' })
    order = []
    await turn.dispose()
    expect(order.sort()).toEqual(['browser-dispose', 'dispose'])
  })

  it('side runs get a to-do-only turn without a browser', async () => {
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'hello')
    const b = svc.sideBase(c.id, 'helper')!
    expect(b.browser).toBe(true)
    const turn = (await svc.sideBrowser(c.id, 'helper'))!
    expect(turn.args).toEqual(['--mcp-config', TODO_CONFIG])
    expect(turn.prompt).toBe('')
    const appendSystemPrompt = [b.args.appendSystemPrompt, turn.prompt].filter(Boolean).join('\n\n')
    expect(buildArgs({ ...b.args, resumeSessionId: null, extraArgs: [...b.args.extraArgs, ...turn.args], appendSystemPrompt })).toEqual(
      calls[0].args
    )
    expect(made[1].agent()).toBe('helper')
    order = []
    await turn.dispose()
    expect(order).toEqual(['dispose'])
  })

  it('a can_use_tool for mcp__zumibot_todos__add is allowed with no approval item, in manual mode', async () => {
    mode = 'manual'
    const risk = vi.fn(async () => null)
    svc = makeService({ todos, todoTurns: todoTurns(), approvalRisk: risk })
    const c = await store.create('helper', dir)
    const input = { items: [{ text: 'Reply to Morjan' }] }
    scripts.push({
      hang: true,
      events: [
        { kind: 'toolUse', id: 'todo-tool', name: 'mcp__zumibot_todos__add', input },
        {
          kind: 'permissionRequest',
          requestId: 'todo-permission',
          toolName: 'mcp__zumibot_todos__add',
          input,
          description: null,
          reason: null,
          toolUseId: 'todo-tool'
        }
      ]
    })
    const done = svc.send(c.id, 'go')
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent).toEqual([allowResponse('todo-permission', input)])
    expect(svc.pendingCount(c.id)).toBe(0)
    expect(pushes.some((p) => p.kind === 'approvals')).toBe(false)
    svc.stop(c.id)
    await done
    expect((await itemsOf(c.id)).some((i) => i.type === 'approval')).toBe(false)
    expect(risk).not.toHaveBeenCalled()
    expect(rules.added).toEqual([])
  })

  it('without the to-do server, a tool of that name asks like any other', async () => {
    mode = 'manual'
    svc = makeService()
    const c = await store.create('helper', dir)
    scripts.push({
      hang: true,
      events: [
        { kind: 'toolUse', id: 'other', name: 'mcp__zumibot_todos__add', input: {} },
        {
          kind: 'permissionRequest',
          requestId: 'other-permission',
          toolName: 'mcp__zumibot_todos__add',
          input: {},
          description: null,
          reason: null,
          toolUseId: 'other'
        }
      ]
    })
    const done = svc.send(c.id, 'go')
    await vi.waitFor(() => expect(svc.pendingCount(c.id)).toBe(1))
    expect(sent).toEqual([])
    svc.stop(c.id)
    await done
    expect((await itemsOf(c.id)).map((i) => i.type)).toContain('tool')
  })

  it("an attempt whose bridge failed to start treats a tool of that name as someone else's", async () => {
    mode = 'manual'
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    svc = makeService({
      todos,
      todoTurns: {
        create: () => {
          throw new Error('To-do list unavailable')
        }
      }
    })
    const c = await store.create('helper', dir)
    scripts.push({
      hang: true,
      events: [
        { kind: 'toolUse', id: 'other', name: 'mcp__zumibot_todos__add', input: {} },
        {
          kind: 'permissionRequest',
          requestId: 'other-permission',
          toolName: 'mcp__zumibot_todos__add',
          input: {},
          description: null,
          reason: null,
          toolUseId: 'other'
        }
      ]
    })
    const done = svc.send(c.id, 'go')
    await vi.waitFor(() => expect(svc.pendingCount(c.id)).toBe(1))
    expect(sent).toEqual([])
    svc.stop(c.id)
    await done
    expect((await itemsOf(c.id)).map((i) => i.type)).toEqual(expect.arrayContaining(['tool', 'approval']))
    log.mockRestore()
  })

  it('to-do tool_use and tool_result add no tool row', async () => {
    const c = await store.create('helper', dir)
    scripts.push({
      events: [
        { kind: 'init', sessionId: 's1' },
        ...todoUse('todo-list', 'list'),
        { kind: 'toolUse', id: 'bash', name: 'Bash', input: { command: 'ls' } },
        { kind: 'toolResult', toolUseId: 'bash', content: 'x', isError: false },
        ...todoUse('todo-add'),
        { kind: 'assistantText', text: 'done' },
        okResult
      ]
    })
    await svc.send(c.id, 'go')
    const items = await itemsOf(c.id)
    expect(items.filter((i) => i.type === 'tool').map((i) => i.id)).toEqual(['bash'])
    expect(JSON.stringify(items)).not.toContain('zumibot_todos')
    expect(JSON.stringify(pushes)).not.toContain('zumibot_todos')
  })

  it("the turn's todos touch lands on its last assistant item, and its items point at that reply", async () => {
    const c = await store.create('helper', dir)
    scripts.push({
      act: agentAdds('Reply to Morjan', 'Call Homam'),
      events: [
        { kind: 'init', sessionId: 's1' },
        { kind: 'assistantText', text: 'Looking' },
        ...todoUse('todo-add'),
        { kind: 'assistantText', text: 'Here is your day' },
        okResult
      ]
    })
    await svc.send(c.id, '/todo plan my day')
    const items = await itemsOf(c.id)
    const reply = items.filter((i) => i.type === 'assistant').at(-1)!
    expect(reply.text).toBe('Here is your day')
    expect(reply.todos).toEqual({ added: 2, ticked: [], unticked: [], removed: [] })
    expect(items.filter((i) => i.todos)).toHaveLength(1)
    const list = await todos.list(c.id)
    expect(list.items.map((i) => i.from)).toEqual(
      [0, 1].map(() => ({ chatId: c.id, turn: made[0].turn, itemId: reply.id, label: 'plan my day', at: expect.any(Number) }))
    )
    expect(list.items.map((i) => i.addedBy)).toEqual(['helper', 'helper'])
    expect(todos.touch(made[0].turn)).toBeNull() // endTurn dropped the record
    expect((await store.loadBoard()).seen).toEqual({ [`${c.id}/helper`]: 0 }) // as its note read the board, before its own adds
    await svc.send(c.id, 'next')
    expect(calls.at(-1)!.stdin).toBe('next') // its own adds are never news to it
  })

  it("a task chat's turn that put questions on its card says so at its end, and its message ends with the card note", async () => {
    await todos.userAdd('Export the report')
    const card = (await todos.list(null)).items[0]!
    const c = await store.create('helper', dir, { task: { todoId: card.id } })
    await todos.userAssign(card.id, 'helper', dir)
    await todos.userStartTask(card.id, { agent: 'helper', chatId: c.id, at: 1 })
    const ends: TurnEnd[] = []
    svc = makeService({ todos, todoTurns: todoTurns(), onTurnEnd: (e) => ends.push(e) })
    const asks = async () => {
      const o = made.at(-1)!
      await todos.agentAskUser(o.chatId, o.agent(), o.turn, [{ text: 'CSV or JSON?' }])
    }
    scripts.push({
      act: asks,
      events: [
        { kind: 'init', sessionId: 's1' },
        ...todoUse('todo-ask', 'ask_user'),
        { kind: 'assistantText', text: 'Asked on the card' },
        okResult
      ]
    })
    await svc.send(c.id, 'Task: Export the report')
    expect(calls.at(-1)!.stdin).toContain('This chat works on a task card on the user\'s task board in ZumiBot: "Export the report"')
    expect(ends.at(-1)).toMatchObject({ chatId: c.id, outcome: 'ok', cardQuestions: true })
    const reply = (await itemsOf(c.id)).filter((i) => i.type === 'assistant').at(-1)!
    expect(reply.todos).toEqual({ added: 0, ticked: [], unticked: [], removed: [], asked: ['CSV or JSON?'] })
    scripts.push({ events: pong })
    await svc.send(c.id, 'thanks')
    expect('cardQuestions' in ends.at(-1)!).toBe(false)
  })

  it('a user tick before the turn puts the state note on stdin; an unchanged list puts none', async () => {
    const c = await store.create('helper', dir)
    scripts.push({ act: agentAdds('Reply to Morjan', 'Call Homam'), events: pong })
    await svc.send(c.id, 'one')
    expect(calls[0].stdin).toBe('one') // a new session, but a list that never had an item adds nothing
    const [first] = (await todos.list(c.id)).items
    await todos.userCheck([first.id], true)
    await svc.send(c.id, 'two')
    expect(calls[1].stdin).toMatch(/^two\n\nThe user's task board/)
    expect(calls[1].stdin).toContain('ticked by the user: Reply to Morjan')
    expect(calls[1].stdin).toContain('Call list to see the whole board.')
    await svc.send(c.id, 'three')
    expect(calls[2].stdin).toBe('three')
    expect(JSON.stringify(await itemsOf(c.id))).not.toContain("The user's task board")
  })

  it("a user tick while the reply runs reaches the next turn's note", async () => {
    const c = await store.create('helper', dir)
    await todos.agentAdd(c.id, 'helper', 'earlier', 'Digest', [{ text: 'Reply to Morjan' }, { text: 'Call Homam' }])
    await seeNow(c.id)
    await store.update(c.id, { sessionId: 's1' })
    let ready!: () => void
    const running = new Promise<void>((resolve) => {
      ready = resolve
    })
    scripts.push({ hang: true, events: [{ kind: 'init', sessionId: 's1' }], ready })
    const done = svc.send(c.id, 'one')
    await running
    await todos.userCheck(['td1'], true) // after the note was read, before the turn ends
    svc.stop(c.id)
    await done
    await svc.send(c.id, 'two')
    expect(calls[1].stdin).toMatch(/^two\n\nThe user's task board/)
    expect(calls[1].stdin).toContain('ticked by the user: Reply to Morjan')
  })

  it("another member's tick while this member's reply runs reaches its next note", async () => {
    const c = await store.create('helper', dir)
    await todos.agentAdd(c.id, 'helper', 'earlier', 'Digest', [{ text: 'Reply to Morjan' }])
    await seeNow(c.id)
    await store.update(c.id, { sessionId: 's1' })
    scripts.push({
      act: async () => {
        await todos.agentCheck(c.id, 'planner', 'planner-turn', ['td1'], true)
      },
      events: pong
    })
    await svc.send(c.id, 'one')
    expect(calls[0].stdin).toBe('one')
    await svc.send(c.id, 'two')
    expect(calls[1].stdin).toContain('ticked by planner: Reply to Morjan')
    await svc.send(c.id, 'three')
    expect(calls[2].stdin).toBe('three') // told once
  })

  it('a reseed gets the forced note', async () => {
    const c = await store.create('helper', dir)
    await todos.agentAdd(c.id, 'helper', 'earlier', 'Digest', [{ text: 'Reply to Morjan' }])
    await seeNow(c.id)
    await store.update(c.id, { sessionId: 'old' })
    scripts.push({ outcome: { result: null, stderr: 'No conversation found with session ID: old' } }, { events: pong })
    await svc.send(c.id, 'go')
    expect(calls[0].stdin).toBe('go') // resumed and nothing changed since the agent saw it
    expect(calls[1].stdin).toMatch(/\n\nThe user's task board[^]*- \[td1\] Reply to Morjan \(by helper; nobody assigned; New\)$/)
    // A chat whose next turn is already a reseed gets it on the first attempt.
    const d = await store.create('helper', dir)
    await todos.agentAdd(d.id, 'helper', 'earlier', 'Digest', [{ text: 'Call Homam' }])
    await seeNow(d.id)
    await store.update(d.id, { sessionId: null, next: { seed: true } })
    await svc.send(d.id, 'go')
    expect(calls[2].stdin).toMatch(/Call Homam \(by helper; nobody assigned; New\)$/)
  })

  it('a todoAsked turn gets the open items even when the agent saw the list', async () => {
    const c = await store.create('helper', dir)
    await todos.agentAdd(c.id, 'helper', 'earlier', 'Digest', [{ text: 'Reply to Morjan' }])
    await seeNow(c.id)
    const turn = async (todoAsked?: boolean) => {
      const running = svc.claim(c.id)
      let items: ChatItem[] = []
      await svc.agentTurn(
        c.id,
        running,
        {
          agentName: 'helper',
          sessionId: 's1',
          prompt: 'go',
          seedPrompt: () => 'seed',
          extraArgs: [],
          disallowedTools: [],
          allowScope: c.id,
          saveSession: async () => {},
          ...(todoAsked === undefined ? {} : { todoAsked })
        },
        {
          get: () => items,
          set: (next) => {
            items = next
          }
        }
      )
      svc.release(c.id, running)
    }
    await turn()
    expect(calls[0].stdin).toBe('go')
    await turn(true)
    expect(calls[1].stdin).toMatch(/^go\n\nThe user's task board[^]*Reply to Morjan/)
  })

  it('a /todo send stores the flag, reads the request line and gets the open items though the agent saw the list', async () => {
    const c = await store.create('helper', dir)
    await store.update(c.id, { sessionId: 's1' })
    await todos.agentAdd(c.id, 'helper', 'earlier', 'Digest', [{ text: 'Reply to Morjan' }])
    await seeNow(c.id)
    await svc.send(c.id, '/todo plan my day', [], undefined, undefined, undefined, true)
    expect(calls[0].stdin).toMatch(
      /^plan my day\n\n.*zumibot_todos tools, each with a description that holds everything needed to act on it\.[^]*Reply to Morjan/
    )
    expect(calls[0].stdin).not.toContain('/todo')
    expect((await store.loadItems(c.id))[0]).toMatchObject({ type: 'user', text: '/todo plan my day', todo: true })
  })

  it('stores the workflow that sent a message on its user item, and a Resend keeps it', async () => {
    const c = await store.create('helper', dir)
    const sent = { workflowId: 'w', runId: 'r', stepId: 's', name: 'WF', step: 'Chat' }
    await svc.send(c.id, 'from a workflow', [], undefined, undefined, undefined, undefined, true, sent)
    const user = (await store.loadItems(c.id)).find((i) => i.type === 'user')!
    expect(user).toMatchObject({ workflowSent: sent })
    await svc.rerun(c.id, user.id, null)
    expect((await store.loadItems(c.id)).filter((i) => i.type === 'user')).toMatchObject([{ workflowSent: sent }])
    await svc.send(c.id, 'typed')
    expect((await store.loadItems(c.id)).filter((i) => i.type === 'user')[1]).not.toHaveProperty('workflowSent')
  })

  it('a send without the flag stores none and gets no note when the agent saw the list', async () => {
    const c = await store.create('helper', dir)
    await store.update(c.id, { sessionId: 's1' })
    await todos.agentAdd(c.id, 'helper', 'earlier', 'Digest', [{ text: 'Reply to Morjan' }])
    await seeNow(c.id)
    await svc.send(c.id, 'plain')
    expect(calls[0].stdin).toBe('plain')
    expect('todo' in (await store.loadItems(c.id))[0]).toBe(false)
  })

  it('resend keeps the old todo flag and an edit takes its own', async () => {
    const c = await store.create('helper', dir)
    await svc.send(c.id, '/todo plan', [], undefined, undefined, undefined, true)
    const id = (await store.loadItems(c.id))[0].id
    await svc.rerun(c.id, id, null)
    const again = (await store.loadItems(c.id)).find((i) => i.type === 'user')!
    expect(again).toMatchObject({ text: '/todo plan', todo: true })
    expect(calls[1].stdin).toContain('plan\n\n')
    await svc.rerun(c.id, again.id, 'plain words')
    const edited = (await store.loadItems(c.id)).find((i) => i.type === 'user')!
    expect(edited).toMatchObject({ text: 'plain words' })
    expect('todo' in edited).toBe(false)
    expect(calls[2].stdin).toBe('plain words')
    await svc.rerun(c.id, edited.id, '/todo again', undefined, true)
    expect((await store.loadItems(c.id)).find((i) => i.type === 'user')).toMatchObject({ text: '/todo again', todo: true })
  })

  it('markSeen runs after a spawned attempt and not after a spawn error', async () => {
    const seen = vi.spyOn(todos, 'markSeen')
    const c = await store.create('helper', dir)
    scripts.push({ outcome: { spawnError: 'spawn claude ENOENT', result: null } })
    await svc.send(c.id, 'go')
    expect(seen).not.toHaveBeenCalled()
    await svc.send(c.id, 'again')
    expect(seen).toHaveBeenCalledWith(c.id, 'helper', 0)
    await expect(fs.access(todoFile(c.id))).rejects.toThrow() // seen on a list that never had an item writes nothing
  })

  it('compact turns get no note and no seen mark, but keep the to-do tools', async () => {
    const c = await store.create('helper', dir)
    await store.update(c.id, { sessionId: 's1' })
    await todos.agentAdd(c.id, 'planner', 'other', 'Digest', [{ text: 'Reply to Morjan' }]) // someone else's change: a note would be due
    const note = vi.spyOn(todos, 'note')
    const seen = vi.spyOn(todos, 'markSeen')
    const settle = vi.spyOn(todos, 'settle')
    scripts.push({ events: [okResult] })
    await svc.compact(c.id, '')
    expect(calls[0].stdin).toBe('/compact')
    expect(note).not.toHaveBeenCalled()
    expect(seen).not.toHaveBeenCalled()
    expect(settle).not.toHaveBeenCalled()
    expect(argAfter(calls[0].args, '--mcp-config')).toBe(TODO_CONFIG)
    expect(argAfter(calls[0].args, '--append-system-prompt')).toContain(TODO_SYSTEM)
  })

  it('the capability env value never appears in a logged error', async () => {
    const c = await store.create('helper', dir)
    scripts.push({ outcome: { spawnError: 'spawn failed: todo-cap-1 at /tmp/private-todo-ipc', result: null } })
    await svc.send(c.id, 'go')
    svc = makeService({
      todos,
      todoTurns: todoTurns(),
      run: () => {
        throw new Error('Failed todo-cap-2 /tmp/private-todo-ipc')
      }
    })
    await svc.send(c.id, 'again')
    const text = JSON.stringify(await itemsOf(c.id))
    expect(text).toContain('spawn failed')
    expect(text).toContain('Failed')
    for (const secret of ['todo-cap-1', 'todo-cap-2', '/tmp/private-todo-ipc']) expect(text).not.toContain(secret)
    expect(order).toEqual(['create', 'dispose', 'create', 'dispose'])
  })

  it('endTurn runs after the dispose, and a chat deleted mid-turn fails no step', async () => {
    const gone = () => Promise.reject(new Error('Chat not found: c'))
    const fake = {
      note: vi.fn(async () => ({ text: null, rev: 0 })),
      touch: vi.fn(() => null),
      settle: vi.fn(gone),
      markSeen: vi.fn(gone),
      endTurn: vi.fn(() => {
        order.push('endTurn')
      })
    }
    svc = makeService({ todos: fake, todoTurns: todoTurns() })
    const c = await store.create('helper', dir)
    await expect(svc.send(c.id, 'go')).resolves.toBeUndefined()
    expect(order).toEqual(['create', 'dispose', 'endTurn'])
    expect(fake.endTurn).toHaveBeenCalledWith(made[0].turn)
    const items = await itemsOf(c.id)
    expect(fake.settle).toHaveBeenCalledWith(c.id, made[0].turn, items.find((i) => i.type === 'assistant')!.id)
    expect(items.some((i) => i.type === 'error')).toBe(false)
  })

  it('a note that cannot be read leaves the message as it was', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(todos, 'note').mockRejectedValue(new Error('EACCES: permission denied, open /data/chats/x.todos.json'))
    const seen = vi.spyOn(todos, 'markSeen')
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'go')
    expect(calls[0].stdin).toBe('go')
    expect(seen).not.toHaveBeenCalled() // the agent read nothing of the list
    expect((await itemsOf(c.id)).some((i) => i.type === 'error')).toBe(false)
    expect(log.mock.calls.flat().join(' ')).not.toContain('/data/chats')
    log.mockRestore()
  })

  it('a to-do IPC that is gone runs the attempt without the tools and without an error', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    svc = makeService({
      todos,
      todoTurns: {
        create: () => {
          throw new Error('To-do list unavailable')
        }
      }
    })
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'go')
    expect(calls[0].args).not.toContain('--mcp-config')
    expect(calls[0].env).toBeUndefined()
    const items = await itemsOf(c.id)
    expect(items.some((i) => i.type === 'error')).toBe(false)
    expect(items.some((i) => i.type === 'assistant' && i.text === 'pong')).toBe(true)
    expect(svc.sideBase(c.id, 'helper')!.browser).toBe(false)
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })

  it("the owner's agent is read per call, so a room member renamed mid-turn follows", async () => {
    const c = await store.create('helper', dir)
    const running = svc.claim(c.id)
    let items: ChatItem[] = []
    const spec = {
      agentName: 'helper',
      author: 'helper',
      turnId: 'room-turn',
      sessionId: null,
      prompt: 'go',
      seedPrompt: () => 'seed',
      extraArgs: [],
      disallowedTools: [],
      allowScope: c.id,
      saveSession: async () => {}
    }
    scripts.push({ hang: true, events: [] })
    const done = svc.agentTurn(c.id, running, spec, {
      get: () => items,
      set: (next) => {
        items = next
      }
    })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(made[0].agent()).toBe('helper')
    spec.author = 'renamed'
    expect(made[0].agent()).toBe('renamed')
    svc.stop(c.id)
    await done
    svc.release(c.id, running)
  })

  const brokenSteps = [
    { label: 'settle', broken: ['settle'] },
    { label: 'markSeen', broken: ['markSeen'] },
    { label: 'touch and endTurn', broken: ['touch', 'endTurn'] }
  ]
  it.each(brokenSteps)('a throwing $label never fails the finished reply', async ({ broken }) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const leak = () => Object.assign(new Error('EACCES: permission denied, open /data/chats/c.todos.json'), { code: 'EACCES' })
    const step = <T>(name: string, ok: T) =>
      broken.includes(name)
        ? () => {
            throw leak()
          }
        : () => ok
    const fake = {
      note: vi.fn(async () => ({ text: null, rev: 2 })),
      touch: vi.fn(step('touch', null)),
      settle: vi.fn(async () => step('settle', undefined)()),
      markSeen: vi.fn(async () => step('markSeen', undefined)()),
      endTurn: vi.fn(step('endTurn', undefined))
    }
    const ends: TurnEnd[] = []
    svc = makeService({ todos: fake, todoTurns: todoTurns(), onTurnEnd: (e) => ends.push(e) })
    const c = await store.create('helper', dir)
    scripts.push({
      events: [{ kind: 'init', sessionId: 's1' }, { kind: 'entry', uuid: 'e1' }, { kind: 'assistantText', text: 'pong' }, okResult]
    })
    await expect(svc.send(c.id, 'go')).resolves.toBeUndefined()
    for (const name of broken) expect(fake[name as keyof typeof fake]).toHaveBeenCalled()
    const items = await itemsOf(c.id)
    expect(items.some((i) => i.type === 'error')).toBe(false)
    expect(items.at(-1)).toMatchObject({ type: 'assistant', text: 'pong', end: { session: 's1', at: 'e1' } })
    expect(ends).toEqual([{ chatId: c.id, agent: 'helper', outcome: 'ok', reply: expect.any(String) }])
    expect(await store.get(c.id)).toMatchObject({ sessionId: 's1', inFlight: false })
    // Only the code: the path in the message never reaches the log.
    const logged = log.mock.calls.flat().join(' ')
    expect(logged).toContain('EACCES')
    expect(logged).not.toContain('/data/chats')
    log.mockRestore()
  })

  it('a cut run (Edit, Resend, a version switch) gets the open items though the agent saw the list', async () => {
    const c = await store.create('helper', dir)
    await todos.agentAdd(c.id, 'helper', 'earlier', 'Digest', [{ text: 'Reply to Morjan' }, { text: 'Call Homam' }])
    scripts.push(
      { events: [{ kind: 'init', sessionId: 's1' }, { kind: 'entry', uuid: 'e1' }, { kind: 'assistantText', text: 'A1' }, okResult] },
      { events: [{ kind: 'init', sessionId: 's1' }, { kind: 'entry', uuid: 'e2' }, { kind: 'assistantText', text: 'A2' }, okResult] },
      { events: [{ kind: 'init', sessionId: 's2' }, { kind: 'entry', uuid: 'f1' }, { kind: 'assistantText', text: 'B2' }, okResult] }
    )
    await svc.send(c.id, 'one')
    await todos.userCheck(['td1'], true)
    await svc.send(c.id, 'two') // the tick is news here, and only here: seen moves past it
    expect(calls[1].stdin).toContain('ticked by the user: Reply to Morjan')
    const second = (await itemsOf(c.id))[2]
    await svc.rerun(c.id, second.id, 'two, edited')
    // The cut session ends before 'two', so it never heard of the tick: it gets the list as it is now.
    expect(calls[2].args).toContain('--resume-session-at')
    expect(calls[2].stdin).toMatch(/^two, edited\n\nThe user's task board[^]*- \[td2\] Call Homam \(by helper; nobody assigned; New\)$/)
    expect(calls[2].stdin).not.toContain('Reply to Morjan')
  })
})

describe('agent vault', () => {
  const VAULT_CONFIG = '{"mcpServers":{"zumibot_vault":{"type":"stdio"}}}'
  const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1]
  let made: VaultOwner[]
  let order: string[]
  const vaultTurns = () => ({
    create: (owner: VaultOwner): VaultTurn => {
      made.push(owner)
      order.push('create')
      return {
        mcp: NO_MCP,
        args: ['--mcp-config', VAULT_CONFIG],
        env: { ZUMIBOT_VAULT_CAPABILITY: `vault-cap-${made.length}`, ZUMIBOT_VAULT_IPC: '/tmp/private-vault-ipc' },
        dispose: () => {
          order.push('dispose')
        }
      }
    }
  })
  const vaultUse = (id: string, content: string, isError = false): RunEvent[] => [
    { kind: 'toolUse', id, name: 'mcp__zumibot_vault__vault_items', input: {} },
    { kind: 'toolResult', toolUseId: id, content, isError }
  ]
  beforeEach(() => {
    made = []
    order = []
    svc = makeService({ todoTurns: { create: () => ({ mcp: NO_MCP, args: [], env: {}, dispose: () => {} }) }, vaultTurns: vaultTurns() })
  })

  it('every run gets the vault bridge and VAULT_SYSTEM whatever the grants', async () => {
    const grants: Record<string, VaultAgentItem[]> = {
      helper: [{ id: 'k1', kind: 'apiKey', name: 'Azure PAT', env: 'AZURE_PAT', description: '' }],
      other: []
    }
    const ipc = await serveVaultIpc({
      items: (agent) => grants[agent] ?? [],
      runtime: { node: '/usr/bin/node', vaultBridgeEntry: '/opt/cb/vaultBridge.mjs', electronNode: false }
    })
    try {
      svc = makeService({
        todoTurns: { create: () => ({ mcp: NO_MCP, args: [], env: {}, dispose: () => {} }) },
        vaultTurns: { create: (owner) => ipc.createVaultTurn(owner) }
      })
      const a = await store.create('helper', dir)
      const b = await store.create('other', dir)
      await svc.send(a.id, 'go')
      await svc.send(b.id, 'go')
      expect(calls).toHaveLength(2)
      const system = calls.map((c) => argAfter(c.args, '--append-system-prompt'))
      expect(system[0]).toBe(system[1])
      expect(system[0]).toContain(VAULT_SYSTEM)
      expect(system[0].indexOf(TODO_SYSTEM)).toBeGreaterThan(-1)
      expect(system[0].indexOf(VAULT_SYSTEM)).toBeGreaterThan(system[0].indexOf(TODO_SYSTEM))
      const configs = calls.map((c) => argAfter(c.args, '--mcp-config'))
      expect(configs[0]).toBe(configs[1])
      expect(JSON.parse(configs[0]).mcpServers.zumibot_vault).toMatchObject({ alwaysLoad: true })
      // The tokens differ per attempt and live in env only.
      const caps = calls.map((c) => c.env?.ZUMIBOT_VAULT_CAPABILITY)
      expect(caps[0]).toMatch(/^[0-9a-f]{64}$/)
      expect(caps[1]).not.toBe(caps[0])
      for (const [i, c] of calls.entries()) expect(c.args.join('\n')).not.toContain(caps[i]!)
    } finally {
      await ipc.close()
    }
  })

  it('without a vault server there is no VAULT_SYSTEM and no vault args', async () => {
    svc = makeService()
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'go')
    expect(argAfter(calls[0].args, '--append-system-prompt') ?? '').not.toContain(VAULT_SYSTEM)
    expect(calls[0].args).not.toContain('--mcp-config')
  })

  it('creates one turn per attempt and disposes it, keeping the key of the logical turn', async () => {
    const c = await store.create('helper', dir)
    await store.update(c.id, { sessionId: 'old' })
    scripts.push({ outcome: { result: null, stderr: 'No conversation found with session ID: old' } }, { events: pong })
    await svc.send(c.id, 'go')
    expect(calls).toHaveLength(2)
    expect(made[1].turn).toBe(made[0].turn)
    expect(made[0]).toMatchObject({ chatId: c.id })
    expect(order).toEqual(['create', 'dispose', 'create', 'dispose'])
    for (const call of calls) expect(call.env?.ZUMIBOT_VAULT_IPC).toBe('/tmp/private-vault-ipc')
  })

  it("answers the vault tool's permission request without a card", async () => {
    mode = 'manual'
    const risk = vi.fn(async () => null)
    svc = makeService({ vaultTurns: vaultTurns(), approvalRisk: risk })
    const c = await store.create('helper', dir)
    scripts.push({
      hang: true,
      events: [
        { kind: 'toolUse', id: 'vault-tool', name: 'mcp__zumibot_vault__vault_items', input: {} },
        {
          kind: 'permissionRequest',
          requestId: 'vault-permission',
          toolName: 'mcp__zumibot_vault__vault_items',
          input: {},
          description: null,
          reason: null,
          toolUseId: 'vault-tool'
        }
      ]
    })
    const done = svc.send(c.id, 'go')
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent).toEqual([allowResponse('vault-permission', {})])
    expect(svc.pendingCount(c.id)).toBe(0)
    expect(pushes.some((p) => p.kind === 'approvals')).toBe(false)
    svc.stop(c.id)
    await done
    expect((await itemsOf(c.id)).some((i) => i.type === 'approval')).toBe(false)
    expect(risk).not.toHaveBeenCalled()
    expect(rules.added).toEqual([])
  })

  it('without the vault server, a tool of that name asks like any other', async () => {
    mode = 'manual'
    svc = makeService()
    const c = await store.create('helper', dir)
    scripts.push({
      hang: true,
      events: [
        { kind: 'toolUse', id: 'other', name: 'mcp__zumibot_vault__vault_items', input: {} },
        {
          kind: 'permissionRequest',
          requestId: 'other-permission',
          toolName: 'mcp__zumibot_vault__vault_items',
          input: {},
          description: null,
          reason: null,
          toolUseId: 'other'
        }
      ]
    })
    const done = svc.send(c.id, 'go')
    await vi.waitFor(() => expect(svc.pendingCount(c.id)).toBe(1))
    expect(sent).toEqual([])
    svc.stop(c.id)
    await done
  })

  it('stores the vault_items row with its item names only', async () => {
    const c = await store.create('helper', dir)
    const listed = JSON.stringify([
      { id: 'secret-id-1', kind: 'login', name: 'Gmail', sites: ['mail.google.com'], username: 'bob@x.com', hasCode: true },
      { id: 'secret-id-2', kind: 'apiKey', name: 'Azure PAT', env: 'AZURE_PAT', description: 'devops token' }
    ])
    scripts.push({
      events: [
        { kind: 'init', sessionId: 's1' },
        ...vaultUse('v1', listed),
        ...vaultUse('v2', '[]'),
        ...vaultUse('v3', 'Vault unavailable', true),
        { kind: 'assistantText', text: 'ok' },
        okResult
      ]
    })
    await svc.send(c.id, 'go')
    const tools = (await itemsOf(c.id)).filter((i) => i.type === 'tool')
    expect(tools.map((t) => t.type === 'tool' && t.result)).toEqual([
      'Checked the vault (2 items): Gmail, Azure PAT',
      'Checked the vault (0 items)',
      'Vault command failed.'
    ])
    const text = JSON.stringify(await itemsOf(c.id)) + JSON.stringify(pushes)
    for (const secret of ['secret-id-1', 'bob@x.com', 'mail.google.com', 'AZURE_PAT', 'devops token']) expect(text).not.toContain(secret)
  })

  it('stores a fill row with the item name and field only', async () => {
    const names: [string, string][] = []
    svc = makeService({
      vaultTurns: vaultTurns(),
      vaultItemName: (id, agent) => {
        names.push([id, agent])
        return id === 'c1' ? 'Work Visa' : null
      }
    })
    const c = await store.create('helper', dir)
    const stamp = { generation: 'gen-1', tabId: 'tab-1', observationId: 'obs-1' }
    const fill = (id: string, item: unknown, field: unknown, content: string, isError: boolean): RunEvent[] => [
      { kind: 'toolUse', id, name: 'mcp__zumibot_browser__browser_fill_from_vault', input: { stamp, ref: 'ref-1', item, field } },
      { kind: 'toolResult', toolUseId: id, content, isError }
    ]
    scripts.push({
      events: [
        { kind: 'init', sessionId: 's1' },
        ...fill('f1', 'c1', 'number', JSON.stringify({ ok: true, data: { filled: true, item: 'Work Visa', field: 'number' } }), false),
        ...fill(
          'f2',
          'secret-other-id',
          'password',
          JSON.stringify({ ok: false, code: 'not_allowed', message: 'No vault item with that id is available to you' }),
          true
        ),
        ...fill(
          'f3',
          'c1',
          'cvc',
          JSON.stringify({ ok: false, code: 'wrong_site', message: 'This login is saved for mail.example.com' }),
          true
        ),
        ...fill('f4', 'c1', 'expiry', JSON.stringify({ ok: false, code: 'denied', message: 'The user denied this card here' }), true),
        ...fill(
          'f5',
          'c1',
          'number',
          JSON.stringify({ ok: false, code: 'command_failed', message: 'Browser command did not complete' }),
          true
        ),
        ...fill('f6', 'c1', 'pin-of-card', 'not json', true),
        { kind: 'assistantText', text: 'ok' },
        okResult
      ]
    })
    await svc.send(c.id, 'go')
    const tools = (await itemsOf(c.id)).filter((i) => i.type === 'tool')
    expect(tools.map((t) => t.type === 'tool' && [t.input, t.result])).toEqual([
      [{ item: 'Work Visa', field: 'number' }, 'Browser command completed.'],
      [{ item: 'unknown item', field: 'password' }, 'Browser command failed: not allowed.'],
      [{ item: 'Work Visa', field: 'cvc' }, 'Browser command failed: wrong site.'],
      [{ item: 'Work Visa', field: 'expiry' }, 'Browser command failed: denied.'],
      [{ item: 'Work Visa', field: 'number' }, 'Browser command failed.'],
      [{ item: 'Work Visa', field: 'unknown field' }, 'Browser command failed.']
    ])
    expect(names[0]).toEqual(['c1', 'helper'])
    const text = JSON.stringify(await itemsOf(c.id)) + JSON.stringify(pushes)
    for (const secret of ['secret-other-id', 'gen-1', 'obs-1', 'ref-1', 'mail.example.com', 'pin-of-card'])
      expect(text).not.toContain(secret)
  })

  it('side runs join the vault bridge', async () => {
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'hello')
    const b = svc.sideBase(c.id, 'helper')!
    expect(b.browser).toBe(true)
    const turn = (await svc.sideBrowser(c.id, 'helper'))!
    expect(turn.args).toContain(VAULT_CONFIG)
    expect(turn.env).toMatchObject({ ZUMIBOT_VAULT_CAPABILITY: 'vault-cap-2', ZUMIBOT_VAULT_IPC: '/tmp/private-vault-ipc' })
    expect(made[1].agent()).toBe('helper')
    // Same args as the main run: the prompt-cache prefix holds.
    const appendSystemPrompt = [b.args.appendSystemPrompt, turn.prompt].filter(Boolean).join('\n\n')
    expect(buildArgs({ ...b.args, resumeSessionId: null, extraArgs: [...b.args.extraArgs, ...turn.args], appendSystemPrompt })).toEqual(
      calls[0].args
    )
    order = []
    await turn.dispose()
    expect(order).toEqual(['dispose'])
  })

  it('puts the vault args after the to-do args and before the ask args', async () => {
    const TODO = '{"mcpServers":{"zumibot_todos":{"type":"stdio"}}}'
    svc = makeService({
      todoTurns: { create: () => ({ mcp: NO_MCP, args: ['--mcp-config', TODO], env: {}, dispose: () => {} }) },
      vaultTurns: vaultTurns()
    })
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'go')
    const args = calls[0].args
    expect(args.indexOf(TODO)).toBeGreaterThan(-1)
    expect(args.indexOf(VAULT_CONFIG)).toBeGreaterThan(args.indexOf(TODO))
  })
})

describe('vault guard', () => {
  const GUARD = vaultGuardSettings({
    keyFile: '/home/u/.config/zumibot-vault/vault.key',
    vaultFile: '/home/u/.local/share/zumibot/vault.json',
    home: '/home/u'
  })
  const pauseJson = pauseSettings({ node: '/opt/node', entry: '/opt/pauseHook.mjs', electronNode: false })
  const settingsOf = (args: string[]) => {
    expect(args.filter((a) => a === '--settings')).toHaveLength(1)
    return JSON.parse(args[args.indexOf('--settings') + 1]) as {
      permissions?: { deny?: string[] }
      hooks?: { PreToolUse?: { matcher: string }[] }
    }
  }
  const guarded = (args: string[]) => (settingsOf(args).permissions?.deny ?? []).includes(KEY_DIR_RULE)

  it('main runs carry the vault guard; side runs and compact do not', async () => {
    svc = makeService({ vaultGuard: GUARD })
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'ping')
    expect(guarded(calls[0].args)).toBe(true)
    // The guard is added only to the spawn, so a side run built from the base keeps its settings.
    expect(svc.sideBase(c.id, 'helper')!.args.extraArgs).not.toContain('--settings')
    await svc.compact(c.id, '')
    expect(calls[1].stdin).toBe('/compact')
    expect(calls[1].args).not.toContain('--settings')
    expect((await svc.sideBrowser(c.id, 'helper'))?.args ?? []).not.toContain(GUARD)
  })

  it('a room member run gets it too, and it joins the pause hook in the one --settings', async () => {
    const tmp = new ChatTmp(join(dir, 'claude-tmp'))
    svc = makeService({ vaultGuard: GUARD, tmp, pauseHook: { settings: pauseJson } })
    const g = await store.createGroup(['ui', 'wk'], dir)
    const r = svc.claim(g.id)
    let items: ChatItem[] = []
    await svc.agentTurn(
      g.id,
      r,
      {
        agentName: 'ui',
        author: 'ui',
        turnId: 'turn-1',
        sessionId: null,
        prompt: 'go',
        seedPrompt: () => 'seed',
        extraArgs: [],
        disallowedTools: [],
        allowScope: `${g.id}:ui`,
        saveSession: async () => {}
      },
      {
        get: () => items,
        set: (next) => {
          items = next
        }
      }
    )
    svc.release(g.id, r)
    const merged = settingsOf(calls[0].args)
    expect(guarded(calls[0].args)).toBe(true)
    expect(merged.hooks?.PreToolUse?.map((h) => h.matcher)).toEqual(['*', 'Bash'])
  })

  it('without the dep a run is exactly as before', async () => {
    svc = makeService()
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'ping')
    expect(calls[0].args).not.toContain('--settings')
  })
})

describe('allow rules', () => {
  const RULE = 'Bash(git branch -D:*)'
  const AGENT_RULE = 'Bash(rm -rf:*)'
  const allowOf = (args: string[]): string[] | undefined => {
    const settings = args.flatMap((a, i) => (args[i - 1] === '--settings' ? [JSON.parse(a) as { permissions?: { allow?: string[] } }] : []))
    return settings.flatMap((x) => x.permissions?.allow ?? [])
  }
  const roomTurn = async (gid: string, member: string): Promise<void> => {
    const r = svc.claim(gid)
    let items: ChatItem[] = []
    await svc.agentTurn(
      gid,
      r,
      {
        agentName: member,
        author: member,
        turnId: `turn-${member}`,
        sessionId: null,
        prompt: 'go',
        seedPrompt: () => 'seed',
        extraArgs: [],
        disallowedTools: [],
        allowScope: `${gid}:${member}`,
        saveSession: async () => {}
      },
      { get: () => items, set: (next) => void (items = next) }
    )
    svc.release(gid, r)
  }

  it('a chat with allowRules spawns claude with them, after the agent rules', async () => {
    svc = makeService({ agentRules: { ...rules, cli: (a) => (a === 'helper' ? [AGENT_RULE] : []) } })
    const c = await store.create('helper', dir)
    await store.update(c.id, { allowRules: [RULE] })
    await svc.send(c.id, 'go')
    expect(allowOf(calls[0].args)).toEqual([RULE, AGENT_RULE])
  })
  it('agent rules alone are passed too', async () => {
    svc = makeService({ agentRules: { ...rules, cli: () => [AGENT_RULE] } })
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'go')
    expect(allowOf(calls[0].args)).toEqual([AGENT_RULE])
  })
  it('none in Plan, even with rules stored', async () => {
    svc = makeService({ agentRules: { ...rules, cli: () => [AGENT_RULE] } })
    const c = await store.create('helper', dir)
    await store.update(c.id, { allowRules: [RULE], permissionMode: 'plan' })
    await svc.send(c.id, 'go')
    expect(calls[0].args).not.toContain('--settings')
  })
  it('a chat with no rules runs exactly as before', async () => {
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'go')
    expect(calls[0].args).not.toContain('--settings')
  })
  it('joins the other settings in the one --settings', async () => {
    svc = makeService({ vaultGuard: '{"permissions":{"deny":["Read(/x/**)"]}}' })
    const c = await store.create('helper', dir)
    await store.update(c.id, { allowRules: [RULE] })
    await svc.send(c.id, 'go')
    expect(calls[0].args.filter((a) => a === '--settings')).toHaveLength(1)
    expect(allowOf(calls[0].args)).toEqual([RULE])
    expect(JSON.stringify(calls[0].args)).toContain('Read(/x/**)')
  })
  it("a room member's run gets the room chat's allowRules", async () => {
    const g = await store.createGroup(['ui', 'wk'], dir)
    await store.update(g.id, { allowRules: [RULE] })
    await roomTurn(g.id, 'ui')
    await roomTurn(g.id, 'wk')
    expect(allowOf(calls[0].args)).toEqual([RULE])
    expect(allowOf(calls[1].args)).toEqual([RULE])
  })
  it('side runs and Compact never get them', async () => {
    svc = makeService({ agentRules: { ...rules, cli: () => [AGENT_RULE] } })
    const c = await store.create('helper', dir)
    await store.update(c.id, { allowRules: [RULE] })
    await svc.send(c.id, 'go')
    expect(allowOf(svc.sideBase(c.id, 'helper')!.args.extraArgs)).toEqual([])
    await svc.compact(c.id, '')
    expect(calls[1].stdin).toBe('/compact')
    expect(calls[1].args).not.toContain('--settings')
  })
})

describe('allowBlocked', () => {
  const CMD = 'git branch -D old && rm -rf /tmp/x'
  const RULE = 'Bash(git branch -D:*)'
  let approvals: ApprovalStore
  const blockedTool = (over: Record<string, unknown> = {}): ChatItem =>
    ({ type: 'tool', id: 't1', name: 'Bash', input: { command: CMD }, result: 'denied', isError: true, blocked: true, blockedBy: 'classifier', ts: 1, ...over }) as ChatItem
  const rulesWith = (): ChatServiceDeps['agentRules'] => ({
    ...rules,
    cli: (a) => approvals.cliRules(a),
    addCli: (a, r) => approvals.add(a, { key: JSON.stringify(['cli', r]), toolName: 'Bash', command: null, cli: r })
  })
  const setup = async (items: ChatItem[] = [blockedTool()], agent = 'helper') => {
    approvals = new ApprovalStore(dir)
    await approvals.load()
    svc = makeService({ agentRules: rulesWith() })
    const c = await store.create(agent, dir)
    await store.saveItems(c.id, items)
    pushes.length = 0
    return c
  }
  const approvalsFile = async (): Promise<string | null> => fs.readFile(join(dir, 'approvals.json'), 'utf8').catch(() => null)
  // A refusal leaves meta, items and approvals.json as they were.
  const refused = async (c: { id: string }, message: string, prefixes = ['git branch -D'], scope: 'chat' | 'agent' = 'chat') => {
    const meta = JSON.stringify(await store.get(c.id))
    const items = JSON.stringify(await itemsOf(c.id))
    const file = await approvalsFile()
    await expect(svc.allowBlocked(c.id, 't1', prefixes, scope)).rejects.toThrow(message)
    expect(JSON.stringify(await store.get(c.id))).toBe(meta)
    expect(JSON.stringify(await itemsOf(c.id))).toBe(items)
    expect(await approvalsFile()).toBe(file)
    expect(pushes).toEqual([])
  }

  it('chat scope: stores the rule on the chat, marks the row, pushes items and meta, returns the continue text', async () => {
    const c = await setup()
    const r = await svc.allowBlocked(c.id, 't1', ['git branch -D'], 'chat')
    expect(r).toEqual({ rules: [RULE], text: continueText([RULE], 'chat', 'helper', null), agent: 'helper' })
    expect((await store.get(c.id))?.allowRules).toEqual([RULE])
    expect((await itemsOf(c.id))[0]).toMatchObject({ id: 't1', allowedAs: 'chat' })
    expect(pushes.filter((p) => p.chatId === c.id).map((p) => p.kind)).toEqual(expect.arrayContaining(['items', 'meta']))
    expect(approvals.cliRules('helper')).toEqual([])
  })
  it('merges into the existing rules without a duplicate, and dedupes the call', async () => {
    const c = await setup([blockedTool(), blockedTool({ id: 't2' })])
    await store.update(c.id, { allowRules: [RULE] })
    const r = await svc.allowBlocked(c.id, 't1', ['git branch -D', 'git branch -D', 'rm -rf'], 'chat')
    expect(r.rules).toEqual([RULE, 'Bash(rm -rf:*)'])
    expect((await store.get(c.id))?.allowRules).toEqual([RULE, 'Bash(rm -rf:*)'])
  })
  it('agent scope: stores a CLI rule for the agent and leaves allowRules alone', async () => {
    const c = await setup()
    const r = await svc.allowBlocked(c.id, 't1', ['git branch -D'], 'agent')
    expect(r.text).toBe(continueText([RULE], 'agent', 'helper', null))
    expect(approvals.cliRules('helper')).toEqual([RULE])
    expect((await store.get(c.id))?.allowRules).toBeUndefined()
    expect((await itemsOf(c.id))[0]).toMatchObject({ allowedAs: 'agent' })
  })
  it('items added while the rules are being stored survive, in the log and in the push (agent scope)', async () => {
    const c = await setup()
    const late = { type: 'user', id: 'late', text: 'also', ts: 5 } as ChatItem
    const inner = rulesWith()!
    svc = makeService({
      agentRules: {
        ...inner,
        addCli: async (a, r) => {
          await inner.addCli(a, r)
          await store.saveItems(c.id, [...(await itemsOf(c.id)), late])
        }
      }
    })
    await svc.allowBlocked(c.id, 't1', ['git branch -D'], 'agent')
    const stored = await itemsOf(c.id)
    expect(stored.map((i) => i.id)).toEqual(['t1', 'late'])
    expect(stored[0]).toMatchObject({ allowedAs: 'agent' })
    const pushed = pushes.filter((p) => p.kind === 'items').at(-1)
    expect(pushed && 'items' in pushed && pushed.items.map((i) => i.id)).toEqual(['t1', 'late'])
  })
  it('items added while the rule is being stored survive (chat scope)', async () => {
    const c = await setup()
    const late = { type: 'user', id: 'late', text: 'also', ts: 5 } as ChatItem
    const patch = store.patchInPlace.bind(store)
    vi.spyOn(store, 'patchInPlace').mockImplementation(async (id, fn) => {
      const r = await patch(id, fn)
      await store.saveItems(id, [...(await itemsOf(id)), late])
      return r
    })
    await svc.allowBlocked(c.id, 't1', ['git branch -D'], 'chat')
    const stored = await itemsOf(c.id)
    expect(stored.map((i) => i.id)).toEqual(['t1', 'late'])
    expect(stored[0]).toMatchObject({ allowedAs: 'chat' })
    const pushed = pushes.filter((p) => p.kind === 'items').at(-1)
    expect(pushed && 'items' in pushed && pushed.items.map((i) => i.id)).toEqual(['t1', 'late'])
  })
  it('a turn that starts while the rules are being stored: rules kept, the log left alone, the row unmarked', async () => {
    const c = await setup()
    const patch = store.patchInPlace.bind(store)
    vi.spyOn(store, 'patchInPlace').mockImplementation(async (id, fn) => {
      const r = await patch(id, fn)
      await store.update(id, { inFlight: true })
      return r
    })
    const r = await svc.allowBlocked(c.id, 't1', ['git branch -D'], 'chat')
    expect(r.rules).toEqual([RULE])
    expect((await store.get(c.id))?.allowRules).toEqual([RULE])
    expect((await itemsOf(c.id))[0]).not.toHaveProperty('allowedAs')
    expect(pushes.some((p) => p.kind === 'items')).toBe(false)
  })
  it('a room: the row\'s agent is item.agent and the text starts with @member', async () => {
    const g = await store.createGroup(['ui', 'wk'], dir)
    approvals = new ApprovalStore(dir)
    await approvals.load()
    svc = makeService({ agentRules: rulesWith() })
    await store.saveItems(g.id, [blockedTool({ agent: 'wk' })])
    const r = await svc.allowBlocked(g.id, 't1', ['git branch -D'], 'agent')
    expect(r.agent).toBe('wk')
    expect(r.text.startsWith('@wk ')).toBe(true)
    expect(approvals.cliRules('wk')).toEqual([RULE])
    const r2 = await svc.allowBlocked(g.id, 't1', ['rm -rf'], 'chat').catch((e: Error) => e.message)
    expect(r2).toBe(ALREADY_ALLOWED)
  })
  it('a row without blockedBy, a non-Bash row and a missing row are not allowable', async () => {
    let c = await setup([blockedTool({ blockedBy: undefined })])
    await refused(c, NOT_ALLOWABLE)
    c = await setup([blockedTool({ name: 'Write' })])
    await refused(c, NOT_ALLOWABLE)
    c = await setup([blockedTool({ id: 'other' })])
    await refused(c, NOT_ALLOWABLE)
  })
  it('refuses the built-in agent, workflow chats and a running chat', async () => {
    let c = await setup([blockedTool()], 'zumi-bot')
    await refused(c, NOT_ALLOWABLE)
    c = await setup()
    await store.update(c.id, { workflow: { workflowId: 'w1', runId: 'r1', stepId: 's1', name: 'W' } })
    await refused(c, NOT_ALLOWABLE)
    c = await setup()
    await store.update(c.id, { workflowTest: 'W' })
    await refused(c, NOT_ALLOWABLE)
    c = await setup()
    await store.update(c.id, { inFlight: true })
    await refused(c, CHAT_BUSY)
  })
  it('a second call for the same row is refused and adds nothing', async () => {
    const c = await setup()
    await svc.allowBlocked(c.id, 't1', ['git branch -D'], 'chat')
    pushes.length = 0
    await refused(c, ALREADY_ALLOWED, ['rm -rf'])
    expect((await store.get(c.id))?.allowRules).toEqual([RULE])
  })
  it('refuses a bad prefix, and an all-or-nothing call stores none when one is bad', async () => {
    const c = await setup()
    await refused(c, checkPrefix('sh -c', CMD)!, ['sh -c'])
    await refused(c, checkPrefix('npm test', CMD)!, ['git branch -D', 'npm test'], 'agent')
    await refused(c, 'between 1 and 10', [])
    await refused(c, 'between 1 and 10', Array.from({ length: 11 }, (_, i) => `git branch -D${i}`))
  })
})

describe('vault API keys', () => {
  const KEY = 'tok-secret-ABCD1234'
  const grants = (agent: string): { env: Record<string, string>; scrub: Map<string, string> } =>
    agent === 'helper'
      ? { env: { AZURE_DEVOPS_EXT_PAT: KEY }, scrub: new Map([[KEY, '[vault: Azure PAT]']]) }
      : { env: {}, scrub: new Map<string, string>() }
  const mk = (extra: Partial<ChatServiceDeps> = {}) => makeService({ vaultEnv: grants, ...extra })
  const dump = async (id: string) => JSON.stringify(await itemsOf(id)) + JSON.stringify(pushes)
  const bashReq = (input: unknown): RunEvent => ({
    kind: 'permissionRequest',
    requestId: 'r1',
    toolName: 'Bash',
    input,
    description: `Run with ${KEY}`,
    reason: `uses ${KEY}`,
    toolUseId: 't1'
  })

  it('gives API keys only to main runs of granted agents', async () => {
    svc = mk()
    const a = await store.create('helper', dir)
    const b = await store.create('other', dir)
    await svc.send(a.id, 'go')
    await svc.send(b.id, 'go')
    await store.update(a.id, { sessionId: 's1' })
    await svc.compact(a.id, '')
    expect(calls).toHaveLength(3)
    expect(calls[0].env?.AZURE_DEVOPS_EXT_PAT).toBe(KEY)
    expect(calls[1].env?.AZURE_DEVOPS_EXT_PAT).toBeUndefined()
    expect(calls[2].env?.AZURE_DEVOPS_EXT_PAT).toBeUndefined()
    // The key is never in argv.
    for (const call of calls) expect(call.args.join('\n')).not.toContain(KEY)
    // A side run builds its own env, with no key.
    const turn = await svc.sideBrowser(a.id, 'helper')
    expect(JSON.stringify(turn?.env ?? {})).not.toContain(KEY)
    expect(svc.sideBase(a.id, 'helper')?.scrub?.get(KEY)).toBe('[vault: Azure PAT]')
  })

  it('the retained side base takes its scrub map from the grants as they are now', async () => {
    const KEY2 = 'tok-rotated-WXYZ9876'
    let current: Map<string, string> = new Map([[KEY, '[vault: Azure PAT]']])
    svc = makeService({ vaultEnv: () => ({ env: {}, scrub: new Map(current) }) })
    const a = await store.create('helper', dir)
    await svc.send(a.id, 'go')
    expect([...svc.sideBase(a.id, 'helper')!.scrub!.keys()]).toEqual([KEY])
    // A key rotated after the turn is scrubbed from a side answer at once, and the old value is no longer held.
    current = new Map([[KEY2, '[vault: Azure PAT]']])
    expect([...svc.sideBase(a.id, 'helper')!.scrub!.keys()]).toEqual([KEY2])
    // Revoked: nothing left to scrub, so no map at all.
    current = new Map()
    expect(svc.sideBase(a.id, 'helper')!.scrub).toBeUndefined()
    // Granted again after that: the new grant is there.
    current = new Map([[KEY, '[vault: Azure PAT]']])
    expect(svc.sideBase(a.id, 'helper')!.scrub?.get(KEY)).toBe('[vault: Azure PAT]')
  })

  it('without the dep, the env is what it was', async () => {
    svc = makeService()
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'go')
    expect(calls[0].env).toBeUndefined()
  })

  it("never lets an API key's env name override a value the server set for the run", async () => {
    // envNameError refuses these names on save; this holds even for one that got past it (a sync join re-validates nothing).
    const tmp = new ChatTmp(join(dir, 'claude-tmp'))
    svc = makeService({
      tmp,
      compactWindow: async () => 400000,
      vaultEnv: () => ({
        env: { CLAUDE_CODE_TMPDIR: '/evil', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1', AZURE_DEVOPS_EXT_PAT: KEY },
        scrub: new Map([[KEY, '[vault: Azure PAT]']])
      })
    })
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'go')
    expect(calls[0].env?.CLAUDE_CODE_TMPDIR).toBe(await tmp.ensure(c.id))
    expect(calls[0].env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('400000')
    expect(calls[0].env?.AZURE_DEVOPS_EXT_PAT).toBe(KEY)
  })

  it('scrubs every string a run stores, pushes and returns', async () => {
    svc = mk()
    const c = await store.create('helper', dir)
    scripts.push({
      events: [
        { kind: 'init', sessionId: 's1' },
        { kind: 'textDelta', text: 'the key is tok-secret-' },
        { kind: 'textDelta', text: 'ABCD1234 ok' },
        { kind: 'assistantText', text: `the key is ${KEY} ok` },
        { kind: 'toolUse', id: 't1', name: 'Bash', input: { command: `echo ${KEY}` } },
        { kind: 'toolResult', toolUseId: 't1', content: `out ${KEY}`, isError: false },
        { kind: 'assistantText', text: `done ${KEY}` },
        okResult
      ]
    })
    await svc.send(c.id, 'go')
    const all = await dump(c.id)
    expect(all).not.toContain(KEY)
    expect(all).toContain('[vault: Azure PAT]')
    const deltas = pushes
      .filter((p) => p.kind === 'delta')
      .map((p) => (p as { text: string }).text)
      .join('')
    expect(deltas).toBe('the key is [vault: Azure PAT] ok')
    const tool = (await itemsOf(c.id)).find((i) => i.type === 'tool')
    expect(tool).toMatchObject({ input: { command: 'echo [vault: Azure PAT]' }, result: 'out [vault: Azure PAT]' })
  })

  it('flushes a held delta tail when the reply ends without a complete message', async () => {
    svc = mk()
    const c = await store.create('helper', dir)
    scripts.push({ events: [{ kind: 'textDelta', text: 'partial reply' }], outcome: { exitCode: 1, stderr: 'x', result: null } })
    await svc.send(c.id, 'go')
    const texts = (await itemsOf(c.id)).filter((i) => i.type === 'assistant').map((i) => (i as { text: string }).text)
    expect(texts).toEqual(['partial reply'])
  })

  it('scrubs an error that carries the key', async () => {
    svc = mk()
    const c = await store.create('helper', dir)
    scripts.push({ events: [{ kind: 'init', sessionId: 's1' }], outcome: { exitCode: 1, stderr: `boom ${KEY}`, result: null } })
    await svc.send(c.id, 'go')
    expect(await dump(c.id)).not.toContain(KEY)
  })

  it('stores a scrubbed tool result but answers a permission with the raw input', async () => {
    mode = 'manual'
    const asked: unknown[][] = []
    svc = mk({
      approvalRisk: async (_c, a) => {
        asked.push([a])
        return null
      }
    })
    const c = await store.create('helper', dir)
    const input = { command: `curl -H "Authorization: ${KEY}" https://x` }
    scripts.push({ hang: true, events: [{ kind: 'toolUse', id: 't1', name: 'Bash', input }, bashReq(input)] })
    const done = svc.send(c.id, 'go')
    await vi.waitFor(() => expect(svc.pendingCount(c.id)).toBe(1))
    const card = (await itemsOf(c.id)).find((i) => i.type === 'approval')
    expect(card).toMatchObject({
      input: { command: 'curl -H "Authorization: [vault: Azure PAT]" https://x' },
      description: 'Run with [vault: Azure PAT]',
      reason: 'uses [vault: Azure PAT]',
      status: 'pending'
    })
    expect(JSON.stringify(asked)).not.toContain(KEY)
    expect(await dump(c.id)).not.toContain(KEY)
    svc.answer(c.id, 'r1', 'allow-agent')
    // The CLI gets the input it sent, so the approved command runs with the real value.
    expect(sent).toEqual([allowResponse('r1', input)])
    // The remembered rule is a stored copy: scrubbed too.
    expect(JSON.stringify(rules.added)).not.toContain(KEY)
    svc.stop(c.id)
    await done
  })

  it('matches a remembered rule on the scrubbed command', async () => {
    mode = 'manual'
    svc = mk()
    const c = await store.create('helper', dir)
    const input = { command: `echo ${KEY}` }
    scripts.push({ hang: true, events: [bashReq(input)] })
    const d1 = svc.send(c.id, 'go')
    await vi.waitFor(() => expect(svc.pendingCount(c.id)).toBe(1))
    svc.answer(c.id, 'r1', 'allow-agent')
    svc.stop(c.id)
    await d1
    sent.length = 0
    scripts.push({ hang: true, events: [{ ...bashReq(input), requestId: 'r2' } as RunEvent] })
    const d2 = svc.send(c.id, 'again')
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent).toEqual([allowResponse('r2', input)])
    expect((await itemsOf(c.id)).filter((i) => i.type === 'approval').pop()).toMatchObject({ status: 'auto-allowed-agent' })
    svc.stop(c.id)
    await d2
  })
})

describe('agent run config', () => {
  const SETTINGS = '{"skillOverrides":{"a":"off"}}'
  const MCP = '{"mcpServers":{}}'
  const CFG: AgentRunConfig = {
    disallowedTools: ['mcp__x'],
    extraArgs: ['--settings', SETTINGS, '--mcp-config', MCP],
    env: { ZUMIBOT_MCP_VAULT_0: 'v' },
    dropped: [],
    connectorPrefixes: {},
    connectorsOff: []
  }
  const BROWSER = '{"mcpServers":{"zumibot_browser":{}}}'
  const TODO = '{"mcpServers":{"zumibot_todos":{}}}'
  const GUARD = vaultGuardSettings({
    keyFile: '/home/u/.config/zumibot-vault/vault.key',
    vaultFile: '/home/u/.local/share/zumibot/vault.json',
    home: '/home/u'
  })
  const pauseJson = pauseSettings({ node: '/opt/node', entry: '/opt/pauseHook.mjs', electronNode: false })
  const KEY = 'tok-secret-ABCD1234'
  const bridges = (): Partial<ChatServiceDeps> => ({
    browserTurns: {
      profileId: async () => 'p',
      create: async () => ({
        mcp: NO_MCP,
        args: ['--mcp-config', BROWSER],
        env: { ZUMIBOT_BROWSER_CAPABILITY: 'browser-cap' },
        prompt: 'Browser prompt',
        dispose: async () => {}
      })
    },
    todoTurns: {
      create: () => ({ mcp: NO_MCP, args: ['--mcp-config', TODO], env: { ZUMIBOT_TODOS_CAPABILITY: 'todo-cap' }, dispose: () => {} })
    }
  })
  const settingsOf = (args: string[]) => {
    expect(args.filter((a) => a === '--settings')).toHaveLength(1)
    return JSON.parse(args[args.indexOf('--settings') + 1]) as Record<string, unknown>
  }
  const tail = (args: string[]) => args.slice(args.indexOf('--disallowedTools'))
  const mcpConfigs = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === '--mcp-config' ? [a] : []))
  const vaultKey = (env: string, value: string, name: string): VaultItem => ({
    id: `id-${name}`,
    updatedAt: 1,
    name,
    agents: ['helper'],
    kind: 'apiKey',
    env,
    value,
    description: ''
  })

  it("a send's run carries the agent's deny rules, settings, servers and env, its servers before the bridges'", async () => {
    const asked: string[] = []
    svc = makeService({
      ...bridges(),
      tmp: new ChatTmp(join(dir, 'claude-tmp')),
      pauseHook: { settings: pauseJson },
      agentRunConfig: async (agent) => {
        asked.push(agent)
        return CFG
      }
    })
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'ping')
    const args = calls[0].args
    expect(asked).toEqual(['helper'])
    expect(tail(args)).toEqual(['--disallowedTools', 'mcp__x'])
    // One --settings: the agent's skill overrides beside the pause hook, merged.
    expect(settingsOf(args)).toEqual({ ...JSON.parse(SETTINGS), ...JSON.parse(pauseJson) })
    expect(args[args.indexOf(MCP) - 1]).toBe('--mcp-config')
    expect(args.indexOf(MCP)).toBeLessThan(args.indexOf(BROWSER))
    expect(args.indexOf(BROWSER)).toBeLessThan(args.indexOf(TODO))
    expect(calls[0].env).toMatchObject({
      ZUMIBOT_MCP_VAULT_0: 'v',
      ZUMIBOT_BROWSER_CAPABILITY: 'browser-cap',
      ZUMIBOT_TODOS_CAPABILITY: 'todo-cap'
    })
  })

  it('reads the config on every attempt', async () => {
    let reads = 0
    svc = makeService({ agentRunConfig: async () => (++reads === 1 ? NO_RUN_CONFIG : CFG) })
    const c = await store.create('helper', dir)
    await store.update(c.id, { sessionId: 'old' })
    // The first attempt's session is gone: the reseed retry is a second attempt, which reads the config again.
    scripts.push({ outcome: { result: null, stderr: 'No conversation found with session ID: old' } }, { events: pong })
    await svc.send(c.id, 'go')
    expect(calls).toHaveLength(2)
    expect(calls[0].args).not.toContain(MCP)
    expect(calls[1].args).toContain(MCP)
    expect(calls[1].env?.ZUMIBOT_MCP_VAULT_0).toBe('v')
  })

  it('a Compact gets the same three parts', async () => {
    // The pause hook and the vault guard are wired, so the main run shows them merged in and the Compact shows they stay out.
    svc = makeService({
      agentRunConfig: async () => CFG,
      vaultGuard: GUARD,
      tmp: new ChatTmp(join(dir, 'claude-tmp')),
      pauseHook: { settings: pauseJson }
    })
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'ping')
    const main = JSON.stringify(settingsOf(calls[0].args))
    expect(main).toContain('ZUMIBOT_PAUSE_FILE')
    expect(main).toContain(JSON.stringify(JSON.parse(GUARD).permissions.deny[0]))
    await svc.compact(c.id, '')
    expect(calls[1].stdin).toBe('/compact')
    // No pause hook or vault guard on a Compact: the agent's settings are its only --settings.
    expect(calls[1].args[calls[1].args.indexOf('--settings') + 1]).toBe(SETTINGS)
    expect(calls[1].args).toContain(MCP)
    expect(tail(calls[1].args)).toEqual(['--disallowedTools', 'mcp__x'])
    expect(calls[1].env?.ZUMIBOT_MCP_VAULT_0).toBe('v')
  })

  it("a room member gets its own agent's set", async () => {
    const asked: string[] = []
    svc = makeService({
      agentRunConfig: async (agent) => {
        asked.push(agent)
        return agent === 'ui' ? CFG : NO_RUN_CONFIG
      }
    })
    const g = await store.createGroup(['ui', 'wk'], dir)
    const r = svc.claim(g.id)
    let items: ChatItem[] = []
    await svc.agentTurn(
      g.id,
      r,
      {
        agentName: 'ui',
        author: 'ui',
        turnId: 'turn-1',
        sessionId: null,
        prompt: 'go',
        seedPrompt: () => 'seed',
        extraArgs: [],
        disallowedTools: ['Agent(wk)'],
        allowScope: `${g.id}:ui`,
        saveSession: async () => {}
      },
      {
        get: () => items,
        set: (next) => {
          items = next
        }
      }
    )
    svc.release(g.id, r)
    expect(asked).toEqual(['ui'])
    expect(tail(calls[0].args)).toEqual(['--disallowedTools', 'Agent(wk)', 'mcp__x'])
    expect(calls[0].args).toContain(MCP)
    expect(svc.sideBase(g.id, 'ui')!.args.disallowedTools).toEqual(['Agent(wk)', 'mcp__x'])
  })

  it('the side base holds the same parts, and a side run built from it keeps their order', async () => {
    svc = makeService({ ...bridges(), agentRunConfig: async () => CFG })
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'ping')
    const b = svc.sideBase(c.id, 'helper')!
    expect(b.args.disallowedTools).toEqual(['mcp__x'])
    expect(b.args.extraArgs).toEqual(CFG.extraArgs)
    expect(b.env).toEqual({ ZUMIBOT_MCP_VAULT_0: 'v' })
    const turn = (await svc.sideBrowser(c.id, 'helper'))!
    // Rebuilt from the base with the side turn's bridges, it is the main run's argv: the prompt-cache prefix holds.
    const appendSystemPrompt = [b.args.appendSystemPrompt, turn.prompt].filter(Boolean).join('\n\n')
    expect(buildArgs({ ...b.args, resumeSessionId: null, extraArgs: [...b.args.extraArgs, ...turn.args], appendSystemPrompt })).toEqual(
      calls[0].args
    )
    // The side run's own argv: the agent's servers still before the bridges', its deny rules still last.
    const side = sideArgs(b, null, turn)
    expect(mcpConfigs(side)).toEqual(mcpConfigs(calls[0].args))
    expect(side.indexOf(MCP)).toBeLessThan(side.indexOf(BROWSER))
    expect(tail(side)).toEqual(['--disallowedTools', 'mcp__x'])
    expect(settingsOf(side).skillOverrides).toEqual({ a: 'off' })
    await turn.dispose()
  })

  it('main and side runs drop the same unfillable server', async () => {
    const DB = 'postgres://db-secret-5678'
    const keys = [vaultKey('DB_URL', DB, 'Database')]
    // Built once, as app.ts builds it for both paths: GITHUB_TOKEN is granted to nobody, so `gh` cannot start.
    const cfg = buildAgentRunConfig(
      {
        ...NO_EXTENSIONS,
        servers: [
          { name: 'gh', def: { command: 'gh-mcp', env: { TOKEN: '${vault:GITHUB_TOKEN}' } } },
          { name: 'db', def: { command: 'db-mcp', env: { URL: '${vault:DB_URL}' } } }
        ]
      },
      keys
    )
    expect(cfg.dropped).toEqual([{ server: 'gh', env: 'GITHUB_TOKEN', reason: 'vault-missing' }])
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      svc = makeService({ ...bridges(), vaultEnv: () => vaultEnvOf(keys), agentRunConfig: async () => cfg })
      const c = await store.create('helper', dir)
      await svc.send(c.id, 'go')
      const main = calls[0].args
      const b = svc.sideBase(c.id, 'helper')!
      const turn = (await svc.sideBrowser(c.id, 'helper'))!
      let spawned!: RunOptions
      const handle: RunHandle = { stop: () => {}, send: () => true, done: new Promise(() => {}) }
      startSideRun({
        base: b,
        point: null,
        message: 'why?',
        browser: turn,
        now: () => 1,
        onText: () => {},
        onCost: () => {},
        run: (o) => {
          spawned = o
          return handle
        }
      })
      const own = (args: string[]) => mcpConfigs(args).filter((a) => 'db' in (JSON.parse(a) as { mcpServers: object }).mcpServers)
      expect(own(main)).toHaveLength(1)
      expect(own(spawned.args)).toEqual(own(main))
      expect(JSON.parse(own(main)[0])).toEqual({ mcpServers: { db: { command: 'db-mcp', env: { URL: '${ZUMIBOT_MCP_VAULT_0}' } } } })
      for (const args of [main, spawned.args]) {
        expect(args.join('\n')).not.toContain('gh-mcp')
        expect(args.join('\n')).not.toContain(DB)
      }
      // The value is in both spawns' env only, and it is a granted API key's, so both scrub it already.
      expect(calls[0].env?.ZUMIBOT_MCP_VAULT_0).toBe(DB)
      expect(spawned.env?.ZUMIBOT_MCP_VAULT_0).toBe(DB)
      expect(b.scrub?.get(DB)).toBe('[vault: Database]')
      // Logged once for the attempt: the server and why, never the key's env name or value.
      const logged = errors.mock.calls.map((a) => a.join(' ')).filter((l) => l.includes('gh'))
      expect(logged).toHaveLength(1)
      expect(logged[0]).toContain('vault-missing')
      expect(logged[0]).not.toContain('GITHUB_TOKEN')
      expect(logged[0]).not.toContain(DB)
      await turn.dispose()
    } finally {
      errors.mockRestore()
    }
  })

  it('an agent with no extension keys runs exactly as before', async () => {
    const rich = (extra: Partial<ChatServiceDeps>) =>
      makeService({
        ...bridges(),
        vaultGuard: GUARD,
        compactWindow: async () => 400000,
        vaultEnv: () => ({ env: { AZURE_DEVOPS_EXT_PAT: KEY }, scrub: new Map([[KEY, '[vault: Azure PAT]']]) }),
        ...extra
      })
    const variants: Partial<ChatServiceDeps>[] = [
      {},
      { agentRunConfig: async () => NO_RUN_CONFIG },
      { agentRunConfig: async () => buildAgentRunConfig(NO_EXTENSIONS, []) }
    ]
    for (const extra of variants) {
      calls = []
      svc = rich(extra)
      const c = await store.create('helper', dir)
      await svc.send(c.id, 'ping')
      const args = calls[0].args
      expect(args).toEqual(
        buildArgs({
          agentName: 'helper',
          effort: 'medium',
          resumeSessionId: null,
          permissionMode: 'auto',
          disallowedTools: [],
          extraArgs: ['--mcp-config', BROWSER, '--mcp-config', TODO, '--settings', GUARD],
          appendSystemPrompt: args[args.indexOf('--append-system-prompt') + 1]
        })
      )
      expect(args).not.toContain('--disallowedTools')
      expect(calls[0].env).toEqual({
        AZURE_DEVOPS_EXT_PAT: KEY,
        ZUMIBOT_BROWSER_CAPABILITY: 'browser-cap',
        ZUMIBOT_TODOS_CAPABILITY: 'todo-cap',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000'
      })
      const b = svc.sideBase(c.id, 'helper')!
      expect(b.args).toMatchObject({ disallowedTools: [], extraArgs: [] })
      expect('env' in b).toBe(false)
    }
    // And with nothing else wired, still no env at all.
    calls = []
    svc = makeService({ agentRunConfig: async () => NO_RUN_CONFIG })
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'ping')
    expect(calls[0].env).toBeUndefined()
    expect(calls[0].args).not.toContain('--settings')
  })

  describe('a kept side base and a Vault value that changed after its main run', () => {
    const OLD = 'postgres://old-secret-1111',
      NEW = 'postgres://new-secret-2222'
    const OWN_EXT: AgentExtensions = {
      ...NO_EXTENSIONS,
      serversOff: ['claude.ai Gmail'],
      skillsOff: ['apple-design'],
      servers: [{ name: 'db', def: { command: 'db-mcp', env: { URL: '${vault:DB_URL}' } } }]
    }
    let grants: VaultItem[]
    let status: 'ready' | 'keyMissing' | 'keyMismatch'
    let reads: number
    let sideRuns: RunOptions[]
    let errors: MockInstance<typeof console.error>
    const isOwn = (config: string) => 'db' in (JSON.parse(config) as { mcpServers: object }).mcpServers
    const own = (args: string[]) => mcpConfigs(args).filter(isOwn)
    const valuesOf = (o: RunOptions) => JSON.stringify(o.args) + JSON.stringify(o.env ?? {})
    // As app.ts wires them: a vault that cannot be opened holds no grants and makes the builder leave keyed servers out.
    const setup = (ext: AgentExtensions = OWN_EXT) => {
      svc = makeService({
        ...bridges(),
        vaultEnv: () => vaultEnvOf(status === 'ready' ? grants : []),
        agentRunConfig: async () => {
          reads++
          return buildAgentRunConfig(ext, status === 'ready' ? grants : 'locked')
        }
      })
      return new SideQuestions({
        store,
        chats: svc,
        groups: {
          refuseCodex: async () => {},
          sideThread: async () => [],
          pickInput: async () => {
            throw new Error('Not a room')
          }
        },
        pick: async () => null,
        baseFor: async () => {
          throw new Error('a kept base is used, never a fresh one')
        },
        run: (o) => {
          sideRuns.push(o)
          const done = new Promise<RunOutcome>((resolve) =>
            setImmediate(() => {
              o.onEvent({ kind: 'assistantText', text: 'ok' })
              resolve(baseOutcome())
            })
          )
          return { stop: () => {}, send: () => true, done }
        },
        broadcast: () => {},
        recordCost: () => {},
        now: () => Date.now()
      })
    }
    // A main run with a clean point, so a side run forks it and a keep-warm ping has something to warm.
    const mainRun = async () => {
      const c = await store.create('helper', dir)
      scripts.push({
        events: [{ kind: 'init', sessionId: 's1' }, { kind: 'entry', uuid: 'e1' }, { kind: 'assistantText', text: 'pong' }, okResult]
      })
      await svc.send(c.id, 'ping')
      return c.id
    }
    const askSide = async (side: SideQuestions, chatId: string, id: string) => {
      const before = sideRuns.length
      await side.ask(chatId, 'Why?', id)
      await vi.waitFor(async () => expect((await side.list(chatId)).find((e) => e.id === id)?.state).toBe('done'))
      expect(sideRuns).toHaveLength(before + 1)
      return sideRuns[before]
    }
    // Everything a side run keeps from its chat's base: the point it forks, the bridges in order, the deny rules, the settings.
    const sameShape = (o: RunOptions, main: RunOptions) => {
      expect(o.args.slice(o.args.indexOf('--resume'), o.args.indexOf('--resume') + 5)).toEqual([
        '--resume',
        's1',
        '--resume-session-at',
        'e1',
        '--fork-session'
      ])
      expect(mcpConfigs(o.args).filter((a) => !isOwn(a))).toEqual(mcpConfigs(main.args).filter((a) => !isOwn(a)))
      expect(tail(o.args)).toEqual(tail(main.args))
      expect(settingsOf(o.args)).toMatchObject({
        deniedMcpServers: [{ serverName: 'claude.ai Gmail' }],
        skillOverrides: { 'apple-design': 'off' }
      })
    }
    beforeEach(() => {
      grants = [vaultKey('DB_URL', OLD, 'Database')]
      status = 'ready'
      reads = 0
      sideRuns = []
      errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    })
    afterEach(() => errors.mockRestore())

    it('an unchanged grant uses the kept base as it is, with no second read', async () => {
      const side = setup()
      const id = await mainRun()
      expect(reads).toBe(1)
      const kept = svc.sideBase(id, 'helper')!
      expect(await svc.refreshSideBase('helper', kept)).toBe(kept)
      const o = await askSide(side, id, 'q1')
      expect(reads).toBe(1)
      sameShape(o, calls[0])
      expect(own(o.args)).toEqual(own(calls[0].args))
      expect(o.env?.ZUMIBOT_MCP_VAULT_0).toBe(OLD)
      expect(await side.warm(id, 'helper')).toBe(true)
      expect(reads).toBe(1)
      expect(own(sideRuns[1].args)).toEqual(own(calls[0].args))
      await side.stopAll()
    })

    it('a revoked grant leaves the server out of the next side run and keep-warm ping', async () => {
      const side = setup()
      const id = await mainRun()
      expect(calls[0].env?.ZUMIBOT_MCP_VAULT_0).toBe(OLD)
      grants = []
      const o = await askSide(side, id, 'q1')
      expect(await side.warm(id, 'helper')).toBe(true)
      const ping = sideRuns[1]
      for (const run of [o, ping]) {
        sameShape(run, calls[0])
        expect(own(run.args)).toEqual([])
        expect(run.args.join('\n')).not.toContain('db-mcp')
        expect(valuesOf(run)).not.toContain(OLD)
        expect(run.env?.ZUMIBOT_MCP_VAULT_0).toBeUndefined()
      }
      // The agent's own parts were read again, and say why the server is gone.
      expect(reads).toBeGreaterThan(1)
      expect(errors.mock.calls.map((a) => a.join(' ')).some((l) => l.includes('db (vault-missing)'))).toBe(true)
      // The chat's base itself is untouched until its next main run.
      expect(svc.sideBase(id, 'helper')!.env).toEqual({ ZUMIBOT_MCP_VAULT_0: OLD })
      await side.stopAll()
    })

    it("an A→B side ask after the asked agent's grant was revoked leaves the server out too", async () => {
      const side = setup()
      const a = await store.create('boss', dir)
      const b0 = await store.create('helper', dir)
      const b = await store.update(b0.id, { asked: { by: 'boss', from: a.id, fromTitle: 'Issue chat', chain: [] } })
      scripts.push({
        events: [{ kind: 'init', sessionId: 's1' }, { kind: 'entry', uuid: 'e1' }, { kind: 'assistantText', text: 'pong' }, okResult]
      })
      expect(
        await svc.runAsked(b.id, {
          from: 'boss',
          message: 'make a card',
          chain: ['boss'],
          parent: a.id,
          signal: new AbortController().signal
        })
      ).toMatchObject({ kind: 'ok' })
      expect(calls[0].env?.ZUMIBOT_MCP_VAULT_0).toBe(OLD)
      grants = []
      const entry = await side.askFrom(b.id, { question: 'Which padding?', from: 'boss', link: null, signal: new AbortController().signal })
      expect(entry.state).toBe('done')
      expect(sideRuns).toHaveLength(1)
      const o = sideRuns[0]
      sameShape(o, calls[0])
      expect(own(o.args)).toEqual([])
      expect(valuesOf(o)).not.toContain(OLD)
      expect(o.env?.ZUMIBOT_MCP_VAULT_0).toBeUndefined()
      expect(reads).toBeGreaterThan(1)
      await side.stopAll()
    })

    it('a rotated key reaches the next side run with its new value only', async () => {
      const side = setup()
      const id = await mainRun()
      grants = [vaultKey('DB_URL', NEW, 'Database')]
      const o = await askSide(side, id, 'q1')
      sameShape(o, calls[0])
      expect(own(o.args)).toEqual(own(calls[0].args))
      expect(JSON.parse(own(o.args)[0])).toEqual({ mcpServers: { db: { command: 'db-mcp', env: { URL: '${ZUMIBOT_MCP_VAULT_0}' } } } })
      expect(o.env?.ZUMIBOT_MCP_VAULT_0).toBe(NEW)
      expect(valuesOf(o)).not.toContain(OLD)
      expect(o.args.join('\n')).not.toContain(NEW)
      await side.stopAll()
    })

    for (const locked of ['keyMismatch', 'keyMissing'] as const) {
      it(`a vault turned ${locked} leaves the server out of the next side run`, async () => {
        const side = setup()
        const id = await mainRun()
        status = locked
        const o = await askSide(side, id, 'q1')
        sameShape(o, calls[0])
        expect(own(o.args)).toEqual([])
        expect(valuesOf(o)).not.toContain(OLD)
        await side.stopAll()
      })
    }

    it('a refresh changes only the own parts and their env: the point, folder, flags and scrub stay', async () => {
      setup()
      const id = await mainRun()
      grants = [vaultKey('DB_URL', NEW, 'Database')]
      const kept = svc.sideBase(id, 'helper')!
      const fresh = await svc.refreshSideBase('helper', kept)
      expect(fresh).not.toBe(kept)
      const rest = (b: SideBase) => {
        const { args, env: _env, ownParts: _parts, ...more } = b
        const { disallowedTools: _d, extraArgs: _e, ...argsRest } = args
        return { ...more, argsRest }
      }
      expect(rest(fresh)).toEqual(rest(kept))
      expect(fresh.env).toEqual({ ZUMIBOT_MCP_VAULT_0: NEW })
      expect(fresh.args.disallowedTools).toEqual(kept.args.disallowedTools)
      expect(fresh.args.extraArgs).toEqual(kept.args.extraArgs)
    })

    it('an agent with no own server values is never refreshed, whatever the vault does, and its side run is as before', async () => {
      const side = setup({ ...NO_EXTENSIONS, skillsOff: ['apple-design'] })
      const id = await mainRun()
      const kept = svc.sideBase(id, 'helper')!
      expect('env' in kept).toBe(false)
      expect('ownParts' in kept).toBe(false)
      grants = []
      status = 'keyMismatch'
      expect(await svc.refreshSideBase('helper', kept)).toBe(kept)
      const o = await askSide(side, id, 'q1')
      expect(reads).toBe(1)
      const turn = (await svc.sideBrowser(id, 'helper'))!
      expect(o.args).toEqual(sideArgs(svc.sideBase(id, 'helper')!, { session: 's1', at: 'e1' }, turn))
      await turn.dispose()
      await side.stopAll()
    })
  })

  it('a failing read leaves the run going with every connector off, and logs only a code', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (const fail of [
        async () => {
          throw Object.assign(new Error('EACCES: /home/u/.claude/agents/helper.md'), { code: 'EACCES' })
        },
        () => {
          throw new Error('sync /home/u/secret')
        }
      ]) {
        calls = []
        errors.mockClear()
        svc = makeService({ agentRunConfig: fail as ChatServiceDeps['agentRunConfig'] })
        const c = await store.create('helper', dir)
        await svc.send(c.id, 'ping')
        expect(calls).toHaveLength(1)
        // Not open: with no read the connected claude.ai connectors must not all come alive, so the deny and its belt are the all-off ones.
        expect(settingsOf(calls[0].args).deniedMcpServers).toEqual(denyEntries(CONNECTOR_IDS).deniedMcpServers)
        expect(calls[0].args).toContain('--disallowedTools')
        expect(tail(calls[0].args).slice(1)).toEqual(expect.arrayContaining(denyEntries(CONNECTOR_IDS).disallowedTools))
        expect(calls[0].args).not.toContain(MCP)
        expect(calls[0].env).toBeUndefined()
        expect((await itemsOf(c.id)).map((i) => i.type)).toEqual(['user', 'assistant'])
        const logged = errors.mock.calls.map((a) => a.join(' '))
        expect(logged.some((l) => /EACCES|error/.test(l))).toBe(true)
        expect(logged.join('\n')).not.toContain('/home/u')
      }
    } finally {
      errors.mockRestore()
    }
  })

  it('a missing agentRunConfig dep still adds nothing (only a failing read denies every connector)', async () => {
    svc = makeService({})
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'ping')
    expect(calls[0].args).not.toContain('--settings')
    expect(calls[0].args).not.toContain('--disallowedTools')
  })
})

describe('agent asks', () => {
  const ASK_CONFIG = '{"mcpServers":{"zumibot_agents":{"type":"stdio"}}}'
  const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1]
  const hasAsk = (o: RunOptions) => o.args.includes(ASK_CONFIG)
  const roster = [
    { name: 'b', description: 'Makes cards in Workiom\nSecond line' },
    { name: 'helper', description: 'Helps' },
    { name: 'a', description: 'Checks issues' }
  ]
  const limitResult: RunEvent = {
    kind: 'result',
    subtype: 'success',
    isError: true,
    numTurns: 1,
    sessionId: 'sb',
    denials: [],
    windows: {},
    uuid: null,
    cost: null
  }
  let owners: AskOwner[]
  let disposed: number
  let ended: string[]
  const askTurns = () => ({
    create: (owner: AskOwner): AskTurn => {
      owners.push(owner)
      return {
        mcp: NO_MCP,
        args: ['--mcp-config', ASK_CONFIG],
        env: {
          ZUMIBOT_ASKS_CAPABILITY: `ask-cap-${owners.length}`,
          ZUMIBOT_ASKS_IPC: '/tmp/private-ask-ipc',
          CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0'
        },
        dispose: () => {
          disposed++
        }
      }
    }
  })
  const withAsks = (extra: Partial<ChatServiceDeps> = {}) =>
    makeService({
      askTurns: askTurns(),
      askRoster: async (agent) => roster.filter((a) => a.name !== agent),
      askEnd: (turn) => {
        ended.push(turn)
      },
      ...extra
    })
  // B's chat as AgentAsks makes it: under B, asked from A's chat.
  const askedChat = async (from: string) => {
    const b = await store.create('b', dir)
    return store.update(b.id, { asked: { by: 'a', from, fromTitle: 'Issue chat', chain: [] }, title: '@a · Issue chat' })
  }
  const askOpts = (parent: string, signal: AbortSignal = new AbortController().signal) => ({
    from: 'a',
    message: 'make a card',
    chain: ['a'],
    parent,
    signal
  })
  const req = (requestId: string, toolName = 'Bash', input: unknown = { command: 'ls' }, toolUseId: string | null = null): RunEvent => ({
    kind: 'permissionRequest',
    requestId,
    toolName,
    input,
    description: null,
    reason: null,
    toolUseId
  })
  const approvalsOf = (chatId: string) =>
    pushes.filter((p): p is Extract<ChatPush, { kind: 'approvals' }> => p.kind === 'approvals' && p.chatId === chatId)
  // A's turn waits on its ask while B's turn waits on a card.
  const waitingAsk = async (signal?: AbortSignal) => {
    const a = await store.create('a', dir)
    const b = await askedChat(a.id)
    scripts.push({ hang: true, events: [{ kind: 'init', sessionId: 'sa' }] })
    const aDone = svc.send(a.id, 'ask b')
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    scripts.push({ hang: true, events: [{ kind: 'init', sessionId: 'sb' }, req('b-card')] })
    const run = svc.runAsked(b.id, askOpts(a.id, signal))
    await vi.waitFor(() => expect(svc.pendingCount(a.id)).toBe(1))
    return { a, b, aDone, run }
  }

  beforeEach(() => {
    owners = []
    disposed = 0
    ended = []
    svc = withAsks()
  })

  it('a single chat gets the ask bridge and the roster on every attempt, and its turn ends once', async () => {
    const c = await store.create('helper', dir)
    await store.update(c.id, { sessionId: 'old' })
    scripts.push({ outcome: { result: null, stderr: 'No conversation found with session ID: old' } }, { events: pong })
    await svc.send(c.id, 'go')
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(argAfter(call.args, '--mcp-config')).toBe(ASK_CONFIG)
      const system = argAfter(call.args, '--append-system-prompt')
      expect(system).toBe(askSystem(roster.filter((a) => a.name !== 'helper')))
      expect(system).toContain('- @b: Makes cards in Workiom')
      expect(system).not.toContain('@helper')
      expect(call.env).toMatchObject({ ZUMIBOT_ASKS_IPC: '/tmp/private-ask-ipc', CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0' })
    }
    expect(calls.map((call) => call.env?.ZUMIBOT_ASKS_CAPABILITY)).toEqual(['ask-cap-1', 'ask-cap-2'])
    // One key per logical turn, as the to-do bridge's: the per-turn ask count spans a reseed retry.
    expect(owners).toHaveLength(2)
    expect(owners[0]).toMatchObject({ chatId: c.id, chain: [] })
    expect(owners[0].agent()).toBe('helper')
    expect(owners[1].turn).toBe(owners[0].turn)
    expect(disposed).toBe(2)
    expect(ended).toEqual([owners[0].turn])
  })

  it('the ask bridge comes after the browser and to-do bridges, and the roster after TODO_SYSTEM', async () => {
    const todos = new TodoService({ store, now: () => 5000, newId: () => `td${++n}`, onChanged: () => {} })
    svc = withAsks({
      todos,
      todoTurns: {
        create: () => ({
          mcp: NO_MCP,
          args: ['--mcp-config', 'todo-config'],
          env: { ZUMIBOT_TODOS_CAPABILITY: 'todo-cap' },
          dispose: () => {}
        })
      },
      browserTurns: {
        profileId: async () => 'profile',
        create: async () => ({
          mcp: NO_MCP,
          args: ['--mcp-config', 'browser-config'],
          env: { ZUMIBOT_BROWSER_CAPABILITY: 'browser-cap' },
          prompt: 'Browser prompt',
          dispose: async () => {}
        })
      }
    })
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'hello')
    const args = calls[0].args
    expect(args.indexOf('browser-config')).toBeLessThan(args.indexOf('todo-config'))
    expect(args.indexOf('todo-config')).toBeLessThan(args.indexOf(ASK_CONFIG))
    expect(argAfter(args, '--append-system-prompt')).toBe(
      [TODO_SYSTEM, askSystem(roster.filter((a) => a.name !== 'helper')), 'Browser prompt'].join('\n\n')
    )
    expect(calls[0].env).toMatchObject({
      ZUMIBOT_BROWSER_CAPABILITY: 'browser-cap',
      ZUMIBOT_TODOS_CAPABILITY: 'todo-cap',
      ZUMIBOT_ASKS_CAPABILITY: 'ask-cap-1'
    })
  })

  it('a room member, Zumi Bot and a Compact get no ask bridge and no roster', async () => {
    const room = await store.create('helper', dir)
    let items: ChatItem[] = []
    const r = svc.claim(room.id)
    await svc.agentTurn(
      room.id,
      r,
      {
        agentName: 'ui',
        author: 'ui',
        turnId: 't1',
        sessionId: null,
        prompt: 'go',
        seedPrompt: () => 'go',
        extraArgs: [],
        disallowedTools: [],
        allowScope: room.id,
        saveSession: async () => {}
      },
      {
        get: () => items,
        set: (next) => {
          items = next
        }
      }
    )
    svc.release(room.id, r)
    const builtInChat = await store.create('zumi-bot', dir)
    await svc.send(builtInChat.id, 'make an agent')
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'one')
    scripts.push({ events: [{ kind: 'init', sessionId: 's1' }, okResult] })
    await svc.compact(c.id, '')
    expect(calls).toHaveLength(4)
    for (const call of [calls[0], calls[1], calls[3]]) {
      expect(hasAsk(call)).toBe(false)
      expect(call.args.join('\n')).not.toContain('- @b')
      expect(call.env?.ZUMIBOT_ASKS_CAPABILITY).toBeUndefined()
    }
    expect(hasAsk(calls[2])).toBe(true)
    expect(owners).toHaveLength(1)
    expect(ended).toEqual([owners[0].turn])
  })

  it('a voice chat is an ordinary chat to the ask bridge: it gets the bridge and the roster like a plain one', async () => {
    svc = withAsks()
    const v = await store.create('helper', dir)
    await store.update(v.id, { voice: true })
    await svc.send(v.id, 'hi')
    expect(hasAsk(calls[0])).toBe(true)
    expect(calls[0].args.join('\n')).toContain('- @b')
  })

  it('a can_use_tool for the ask tool is allowed with no card, rule or risk hint; its call stays a tool row', async () => {
    const risk = vi.fn(async () => null)
    svc = withAsks({ approvalRisk: risk })
    const c = await store.create('helper', dir)
    const input = { agent: 'b', message: 'make a card' }
    scripts.push({
      hang: true,
      events: [{ kind: 'toolUse', id: 'ask-tool', name: ASK_TOOL, input }, req('ask-permission', ASK_TOOL, input, 'ask-tool')]
    })
    const done = svc.send(c.id, 'ask b')
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent).toEqual([allowResponse('ask-permission', input)])
    expect(svc.pendingCount(c.id)).toBe(0)
    expect(pushes.some((p) => p.kind === 'approvals')).toBe(false)
    svc.stop(c.id)
    await done
    const items = await itemsOf(c.id)
    expect(items.some((i) => i.type === 'approval')).toBe(false)
    // A's chat shows the call as its ask card.
    expect(items.find((i) => i.type === 'tool')).toMatchObject({ name: ASK_TOOL, input })
    expect(risk).not.toHaveBeenCalled()
    expect(rules.added).toEqual([])
  })

  it('a can_use_tool for the side-ask tool is allowed with no card, rule or risk hint', async () => {
    const risk = vi.fn(async () => null)
    svc = withAsks({ approvalRisk: risk })
    const c = await store.create('helper', dir)
    const input = { agent: 'b', message: 'what do you think?' }
    scripts.push({
      hang: true,
      events: [{ kind: 'toolUse', id: 'side-tool', name: ASK_SIDE_TOOL, input }, req('side-permission', ASK_SIDE_TOOL, input, 'side-tool')]
    })
    const done = svc.send(c.id, 'ask b aside')
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent).toEqual([allowResponse('side-permission', input)])
    expect(svc.pendingCount(c.id)).toBe(0)
    svc.stop(c.id)
    await done
    expect((await itemsOf(c.id)).some((i) => i.type === 'approval')).toBe(false)
    expect(risk).not.toHaveBeenCalled()
    expect(rules.added).toEqual([])
  })

  it("a side run's ask owner carries the entry it answers, and disposing it ends that turn", async () => {
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'hello')
    const turn = (await svc.sideBrowser(c.id, 'helper', { chatId: c.id, entryId: 'e1' }))!
    expect(owners[1]).toMatchObject({ chatId: c.id, chain: [], side: { chatId: c.id, entryId: 'e1' } })
    expect(ended).toEqual([owners[0].turn])
    await turn.dispose()
    expect(ended).toEqual([owners[0].turn, owners[1].turn])
    // Without an entry (the existing callers) the owner is as before.
    const plain = (await svc.sideBrowser(c.id, 'helper'))!
    expect(owners[2].side).toBeUndefined()
    await plain.dispose()
  })

  it("sideBrowser takes the caller's asks over the live base, and needs no live base for asks=true", async () => {
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'hello')
    expect(svc.sideBase(c.id, 'helper')).toMatchObject({ asks: true })
    // The caller's base says no tool, so none is made even though the live base had one.
    const off = await svc.sideBrowser(c.id, 'helper', { chatId: c.id, entryId: 'e1' }, false)
    expect(owners).toHaveLength(1)
    expect(off).toBeNull()
    // No live base for this agent (a fresh one from the app): the caller's `true` makes the ask turn.
    const fresh = (await svc.sideBrowser(c.id, 'newcomer', { chatId: c.id, entryId: 'e2' }, true))!
    expect(owners).toHaveLength(2)
    expect(owners[1]).toMatchObject({ chatId: c.id, side: { chatId: c.id, entryId: 'e2' } })
    expect(fresh.args).toEqual(['--mcp-config', ASK_CONFIG])
    await fresh.dispose()
    // No live base and no answer from the caller: no ask turn.
    expect(await svc.sideBrowser(c.id, 'newcomer', { chatId: c.id, entryId: 'e3' })).toBeNull()
    expect(owners).toHaveLength(2)
  })

  it("a throwing askEnd never fails a side run's dispose", async () => {
    svc = withAsks({
      askEnd: () => {
        throw new Error('end broke')
      }
    })
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'hello')
    const turn = (await svc.sideBrowser(c.id, 'helper', { chatId: c.id, entryId: 'e1' }))!
    await expect(turn.dispose()).resolves.toBeUndefined()
  })

  it('without the ask bridge, a tool of that name asks like any other', async () => {
    svc = makeService()
    const c = await store.create('helper', dir)
    scripts.push({
      hang: true,
      events: [{ kind: 'toolUse', id: 'other', name: ASK_TOOL, input: {} }, req('other-permission', ASK_TOOL, {}, 'other')]
    })
    const done = svc.send(c.id, 'go')
    await vi.waitFor(() => expect(svc.pendingCount(c.id)).toBe(1))
    expect(sent).toEqual([])
    svc.stop(c.id)
    await done
    expect((await itemsOf(c.id)).map((i) => i.type)).toEqual(expect.arrayContaining(['tool', 'approval']))
  })

  it('a bridge that fails to start costs the run only the tool, and a broken roster only the paragraph', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    svc = withAsks({
      askTurns: {
        create: () => {
          throw new Error('Agents unavailable')
        }
      },
      askRoster: async () => {
        throw new Error('EACCES /home/u/.claude/agents')
      }
    })
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'go')
    expect(hasAsk(calls[0])).toBe(false)
    expect(calls[0].args).not.toContain('--append-system-prompt')
    expect((await itemsOf(c.id)).map((i) => i.type)).toEqual(['user', 'assistant'])
    expect(log.mock.calls.flat().join(' ')).not.toContain('/home/u')
    log.mockRestore()
  })

  it('the capability env values never appear in an error item, and a throwing askEnd never fails the turn', async () => {
    svc = withAsks({
      askEnd: () => {
        throw new Error('end broke')
      }
    })
    const c = await store.create('helper', dir)
    scripts.push({ outcome: { spawnError: 'spawn failed: ask-cap-1 at /tmp/private-ask-ipc', result: null } })
    await expect(svc.send(c.id, 'go')).resolves.toBeUndefined()
    const text = JSON.stringify(await itemsOf(c.id))
    expect(text).toContain('spawn failed')
    for (const secret of ['ask-cap-1', '/tmp/private-ask-ipc']) expect(text).not.toContain(secret)
    expect((await store.get(c.id))?.inFlight).toBe(false)
  })

  it('a side run gets an ask bridge of its own when the main run had one, with no chain', async () => {
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'hello')
    const base = svc.sideBase(c.id, 'helper')!
    expect(base).toMatchObject({ browser: true, asks: true })
    const turn = (await svc.sideBrowser(c.id, 'helper'))!
    expect(turn.args).toEqual(['--mcp-config', ASK_CONFIG])
    expect(turn.env.ZUMIBOT_ASKS_CAPABILITY).toBe('ask-cap-2')
    const appendSystemPrompt = [base.args.appendSystemPrompt, turn.prompt].filter(Boolean).join('\n\n')
    expect(
      buildArgs({ ...base.args, resumeSessionId: null, extraArgs: [...base.args.extraArgs, ...turn.args], appendSystemPrompt })
    ).toEqual(calls[0].args)
    expect(owners[1]).toMatchObject({ chatId: c.id, chain: [] })
    expect(owners[1].agent()).toBe('helper')
    expect(owners[1].turn).not.toBe(owners[0].turn)
    await turn.dispose()
    expect(disposed).toBe(2)
    // Zumi Bot's own run had none, so its side run has none either.
    const builtInChat = await store.create('zumi-bot', dir)
    await svc.send(builtInChat.id, 'hi')
    expect(svc.sideBase(builtInChat.id, 'zumi-bot')).toMatchObject({ browser: false, asks: false })
    expect(await svc.sideBrowser(builtInChat.id, 'zumi-bot')).toBeNull()
  })

  it("runAsked records the asker's message, tells B who asks and returns its last reply; a second ask while it runs is busy", async () => {
    const a = await store.create('a', dir)
    const b = await askedChat(a.id)
    scripts.push({
      events: [
        { kind: 'init', sessionId: 'sb' },
        { kind: 'assistantText', text: 'looking' },
        { kind: 'toolUse', id: 't', name: 'Bash', input: {} },
        { kind: 'toolResult', toolUseId: 't', content: 'ok', isError: false },
        { kind: 'assistantText', text: 'pong' },
        okResult
      ]
    })
    expect(await svc.runAsked(b.id, askOpts(a.id))).toEqual({ kind: 'ok', reply: 'pong' })
    expect((await itemsOf(b.id))[0]).toMatchObject({ type: 'user', text: 'make a card', from: 'a' })
    expect(calls[0].stdin).toBe('make a card')
    expect(argAfter(calls[0].args, '--agent')).toBe('b')
    const system = argAfter(calls[0].args, '--append-system-prompt')
    expect(system).toContain(askedSystem('a', 'Issue chat'))
    expect(system).toContain(askSystem(roster.filter((x) => x.name !== 'b')))
    // B may ask on, one hop further down the chain.
    expect(owners[0]).toMatchObject({ chatId: b.id, chain: ['a'] })
    expect(owners[0].agent()).toBe('b')
    expect(await store.get(b.id)).toMatchObject({ inFlight: false, sessionId: 'sb', title: '@a · Issue chat' })
    expect(svc.isRunning(b.id)).toBe(false)

    scripts.push({ hang: true, events: [] })
    const first = svc.runAsked(b.id, askOpts(a.id))
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(await svc.runAsked(b.id, askOpts(a.id))).toEqual({ kind: 'busy' })
    expect((await itemsOf(b.id)).filter((i) => i.type === 'user')).toHaveLength(2)
    svc.stop(b.id)
    expect(await first).toEqual({ kind: 'stopped' })
    expect(svc.isRunning(b.id)).toBe(false)
  })

  it("a reply with no text is null (never an earlier exchange's), a failed turn is an error and a limited one carries its reset", async () => {
    const a = await store.create('a', dir)
    const b = await askedChat(a.id)
    await svc.runAsked(b.id, askOpts(a.id))
    scripts.push({
      events: [
        { kind: 'init', sessionId: 's1' },
        { kind: 'toolUse', id: 't', name: 'Bash', input: {} },
        { kind: 'toolResult', toolUseId: 't', content: 'ok', isError: false },
        okResult
      ]
    })
    expect(await svc.runAsked(b.id, askOpts(a.id))).toEqual({ kind: 'ok', reply: null })
    scripts.push({ outcome: { exitCode: 1, stderr: 'boom', result: null } })
    expect(await svc.runAsked(b.id, askOpts(a.id))).toEqual({ kind: 'error' })
    scripts.push({
      events: [
        { kind: 'init', sessionId: 's1' },
        { kind: 'limited', resetsAt: 5_000_000 },
        { kind: 'assistantText', text: "You've hit your session limit" },
        limitResult
      ],
      outcome: { exitCode: 1, result: limitResult as RunOutcome['result'] }
    })
    expect(await svc.runAsked(b.id, askOpts(a.id))).toEqual({ kind: 'limited', resetsAt: 5_000_000 })
    located = null
    expect(await svc.runAsked(b.id, askOpts(a.id))).toEqual({ kind: 'error' })
    expect(svc.isRunning(b.id)).toBe(false)
  })

  it('runAsked reply unchanged after turnReply move', async () => {
    // The rule now lives in shared/turnReply.ts (workflow Agent steps read their output the same way).
    const { turnOutcome } = await import('@zumibot/shared/turnReply')
    const a = await store.create('a', dir)
    const b = await askedChat(a.id)
    scripts.push({ events: [{ kind: 'init', sessionId: 'sb' }, { kind: 'assistantText', text: 'first answer' }, okResult] })
    expect(await svc.runAsked(b.id, askOpts(a.id))).toEqual({ kind: 'ok', reply: 'first answer' })
    scripts.push({
      events: [
        { kind: 'init', sessionId: 'sb' },
        { kind: 'assistantText', text: 'checking' },
        { kind: 'toolUse', id: 't', name: 'Bash', input: {} },
        { kind: 'toolResult', toolUseId: 't', content: 'ok', isError: false },
        { kind: 'assistantText', text: 'second answer' },
        okResult
      ]
    })
    expect(await svc.runAsked(b.id, askOpts(a.id))).toEqual({ kind: 'ok', reply: 'second answer' })
    const items = await itemsOf(b.id)
    const second = items.filter((i) => i.type === 'user')[1]!
    expect(turnOutcome(items, second.id)).toMatchObject({ reply: 'second answer', kind: 'ok', over: false })
    scripts.push({
      events: [
        { kind: 'init', sessionId: 'sb' },
        { kind: 'toolUse', id: 't2', name: 'Bash', input: {} },
        { kind: 'toolResult', toolUseId: 't2', content: 'ok', isError: false },
        okResult
      ]
    })
    expect(await svc.runAsked(b.id, askOpts(a.id))).toEqual({ kind: 'ok', reply: null })
  })

  it('in an asked turn, AskUserQuestion is denied with a pointer back to the asker and gets no card', async () => {
    const a = await store.create('a', dir)
    const b = await askedChat(a.id)
    const input = { questions: [{ question: 'Which board?', header: 'Board', options: [], multiSelect: false }] }
    scripts.push({
      events: [
        { kind: 'init', sessionId: 'sb' },
        { kind: 'toolUse', id: 'q', name: 'AskUserQuestion', input },
        req('q-permission', 'AskUserQuestion', input, 'q'),
        { kind: 'assistantText', text: 'Which board should the card go to?' },
        okResult
      ]
    })
    expect(await svc.runAsked(b.id, askOpts(a.id))).toEqual({ kind: 'ok', reply: 'Which board should the card go to?' })
    expect(sent).toEqual([denyResponse('q-permission', QUESTIONS_DENIED('a'))])
    expect((await itemsOf(b.id)).some((i) => i.type === 'approval')).toBe(false)
    expect(pushes.some((p) => p.kind === 'approvals' && p.pending > 0)).toBe(false)
  })

  it("B's pending cards count as A's chat's, pushed up the chain, and drop to 0 after the run", async () => {
    const a = await store.create('a', dir)
    const b = await askedChat(a.id)
    scripts.push({ hang: true, events: [{ kind: 'init', sessionId: 'sa' }] })
    const aDone = svc.send(a.id, 'ask b')
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    let go!: () => void
    const gate = new Promise<void>((resolve) => {
      go = resolve
    })
    scripts.push({
      act: async () => {
        emit(req('b-card'))
        await gate
      },
      events: [{ kind: 'init', sessionId: 'sb' }, { kind: 'assistantText', text: 'pong' }, okResult]
    })
    const run = svc.runAsked(b.id, askOpts(a.id))
    await vi.waitFor(() => expect(svc.pendingCount(a.id)).toBe(1))
    expect(svc.pendingCount(b.id)).toBe(1)
    expect(approvalsOf(b.id)).toEqual([{ chatId: b.id, kind: 'approvals', pending: 1, agent: 'b', asked: true }])
    expect(approvalsOf(a.id)).toEqual([{ chatId: a.id, kind: 'approvals', pending: 1, agent: 'b' }])
    // Answered from A's chat, by B's chat id.
    svc.answer(b.id, 'b-card', 'allow-once')
    expect(sent).toEqual([allowResponse('b-card', { command: 'ls' })])
    expect(svc.pendingCount(a.id)).toBe(0)
    go()
    expect(await run).toEqual({ kind: 'ok', reply: 'pong' })
    expect(svc.pendingCount(a.id)).toBe(0)
    expect(svc.pendingCount(b.id)).toBe(0)
    expect(approvalsOf(a.id).at(-1)).toMatchObject({ pending: 0 })
    expect(approvalsOf(a.id).every((p) => p.asked === undefined)).toBe(true)
    expect(approvalsOf(b.id).at(-1)).toMatchObject({ pending: 0, asked: true })
    expect(svc.isRunning(a.id)).toBe(true)
    svc.stop(a.id)
    await aDone
  })

  it('a card two asks down counts in every chat above it, and Stop cascades down the chain', async () => {
    const a = await store.create('a', dir)
    const b = await askedChat(a.id)
    const c = await store.create('c', dir)
    await store.update(c.id, { asked: { by: 'b', from: b.id, fromTitle: '@a · Issue chat', chain: ['a'] } })
    scripts.push({ hang: true, events: [] }, { hang: true, events: [] }, { hang: true, events: [req('c-card')] })
    const aDone = svc.send(a.id, 'ask b')
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    const bRun = svc.runAsked(b.id, askOpts(a.id))
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    const cRun = svc.runAsked(c.id, { from: 'b', message: 'help', chain: ['a', 'b'], parent: b.id, signal: new AbortController().signal })
    await vi.waitFor(() => expect(svc.pendingCount(a.id)).toBe(1))
    expect(owners.at(-1)).toMatchObject({ chatId: c.id, chain: ['a', 'b'] })
    expect(svc.pendingCount(b.id)).toBe(1)
    expect(approvalsOf(c.id)).toEqual([{ chatId: c.id, kind: 'approvals', pending: 1, agent: 'c', asked: true }])
    expect(approvalsOf(b.id)).toEqual([{ chatId: b.id, kind: 'approvals', pending: 1, agent: 'c', asked: true }])
    expect(approvalsOf(a.id)).toEqual([{ chatId: a.id, kind: 'approvals', pending: 1, agent: 'c' }])
    // A reloaded page reads the same numbers the pushes gave, asked chats included.
    expect(svc.pendingCounts()).toEqual({ [a.id]: 1, [b.id]: 1, [c.id]: 1 })
    svc.stop(a.id)
    expect(await cRun).toEqual({ kind: 'stopped' })
    expect(await bRun).toEqual({ kind: 'stopped' })
    await aDone
    for (const id of [a.id, b.id, c.id]) {
      expect(svc.pendingCount(id)).toBe(0)
      expect(svc.isRunning(id)).toBe(false)
      expect((await store.get(id))?.inFlight).toBe(false)
    }
  })

  it("stopping A's chat stops B: its card ends unanswered, both counts drop to 0 and neither chat stays in flight", async () => {
    const { a, b, aDone, run } = await waitingAsk()
    svc.stop(a.id)
    expect(await run).toEqual({ kind: 'stopped' })
    await aDone
    expect((await itemsOf(b.id)).find((i) => i.type === 'approval')).toMatchObject({ id: 'b-card', status: 'unanswered' })
    for (const id of [a.id, b.id]) {
      expect(svc.pendingCount(id)).toBe(0)
      expect(approvalsOf(id).at(-1)).toMatchObject({ pending: 0 })
      expect(svc.isRunning(id)).toBe(false)
      expect((await store.get(id))?.inFlight).toBe(false)
    }
    expect((await itemsOf(b.id)).at(-1)).toMatchObject({ type: 'notice', kind: 'stopped' })
  })

  it("aborting the ask's signal stops B the same way and leaves A running", async () => {
    const ctl = new AbortController()
    const { a, b, aDone, run } = await waitingAsk(ctl.signal)
    ctl.abort()
    expect(await run).toEqual({ kind: 'stopped' })
    expect((await itemsOf(b.id)).find((i) => i.type === 'approval')).toMatchObject({ status: 'unanswered' })
    expect(svc.pendingCount(a.id)).toBe(0)
    expect(svc.isRunning(b.id)).toBe(false)
    expect((await store.get(b.id))?.inFlight).toBe(false)
    expect(svc.isRunning(a.id)).toBe(true)
    svc.stop(a.id)
    await aDone
  })

  it('an ask whose signal is already aborted runs nothing', async () => {
    const a = await store.create('a', dir)
    const b = await askedChat(a.id)
    const ctl = new AbortController()
    ctl.abort()
    expect(await svc.runAsked(b.id, askOpts(a.id, ctl.signal))).toEqual({ kind: 'stopped' })
    expect(calls).toHaveLength(0)
    expect(await itemsOf(b.id)).toEqual([])
    expect(svc.isRunning(b.id)).toBe(false)
  })

  it('deleting the A to B chat while B works (stop, then the row goes) ends the ask as stopped and leaves nothing claimed', async () => {
    const { a, b, aDone, run } = await waitingAsk()
    // What chats:remove does: stop without waiting, then remove.
    svc.stop(b.id)
    await store.remove(b.id)
    expect(await run).toEqual({ kind: 'stopped' })
    expect(svc.isRunning(b.id)).toBe(false)
    expect(svc.pendingCount(a.id)).toBe(0)
    expect(approvalsOf(a.id).at(-1)).toMatchObject({ pending: 0 })
    expect(await store.get(b.id)).toBeNull()
    expect(svc.isRunning(a.id)).toBe(true)
    svc.stop(a.id)
    await aDone
    expect((await store.get(a.id))?.inFlight).toBe(false)
  })

  it('the turn end of an asked chat says so', async () => {
    const ends: TurnEnd[] = []
    svc = withAsks({ onTurnEnd: (e) => ends.push(e) })
    const a = await store.create('a', dir)
    const b = await askedChat(a.id)
    await svc.runAsked(b.id, askOpts(a.id))
    await svc.send(a.id, 'hi')
    expect(ends).toEqual([
      { chatId: b.id, agent: 'b', outcome: 'ok', reply: expect.any(String), asked: true },
      { chatId: a.id, agent: 'a', outcome: 'ok', reply: expect.any(String) }
    ])
  })
})

describe('Zumi Bot automations', () => {
  const AUTO_CONFIG = '{"mcpServers":{"zumibot_automations":{"type":"stdio"}}}'
  const SAVE = `${AUTOMATION_PREFIX}routine_save`
  const DELETE = `${AUTOMATION_PREFIX}routine_delete`
  const del = { id: 'r1', name: 'Daily tech hashtags' }
  const mcpConfigs = (args: string[]) => args.flatMap((a, i) => (a === '--mcp-config' ? [args[i + 1]] : []))
  const settingsOf = (args: string[]) => {
    expect(args.filter((a) => a === '--settings')).toHaveLength(1)
    return JSON.parse(args[args.indexOf('--settings') + 1]) as {
      permissions?: { ask?: string[]; deny?: string[] }
      hooks?: { PreToolUse?: { matcher: string }[] }
    }
  }
  const req = (requestId: string, toolName: string, input: unknown = {}, toolUseId: string | null = null): RunEvent => ({
    kind: 'permissionRequest',
    requestId,
    toolName,
    input,
    description: null,
    reason: null,
    toolUseId
  })
  const approvalsIn = async (id: string) =>
    (await itemsOf(id)).filter((i): i is Extract<ChatItem, { type: 'approval' }> => i.type === 'approval')
  const chatMemory = () => (svc as unknown as { allowed: Map<string, Set<string>> }).allowed
  let owners: AutomationOwner[]
  let sides: boolean[]
  let disposed: number
  const automationTurns = () => ({
    create: (owner: AutomationOwner, o: { side?: true } = {}): AutomationTurn => {
      owners.push(owner)
      sides.push(o.side === true)
      return {
        mcp: NO_MCP,
        args: ['--mcp-config', AUTO_CONFIG, ...(o.side ? [] : ['--settings', AUTOMATION_ASK_SETTINGS])],
        env: { ZUMIBOT_AUTOMATIONS_CAPABILITY: `auto-cap-${owners.length}`, ZUMIBOT_AUTOMATIONS_IPC: '/tmp/private-automation-ipc' },
        dispose: () => {
          disposed++
        }
      }
    }
  })
  // A turn that holds after its events, so its cards can be answered; `auto` sends it as a message the user did not type.
  const hold = async (chatId: string, events: RunEvent[], auto?: true) => {
    let ready!: () => void
    const emitted = new Promise<void>((resolve) => {
      ready = resolve
    })
    scripts.push({ hang: true, events, ready })
    const p = svc.send(chatId, 'go', [], undefined, undefined, undefined, undefined, auto)
    await emitted
    return { p } // wrapped: an async function returning the send's promise would wait for it
  }

  beforeEach(() => {
    owners = []
    sides = []
    disposed = 0
    svc = makeService({ automationTurns: automationTurns() })
  })

  it("every attempt of a Zumi Bot turn gets the bridge: writable for the user's message, read-only for one it did not type", async () => {
    const c = await store.create('zumi-bot', dir)
    await store.update(c.id, { sessionId: 'old' })
    scripts.push({ outcome: { result: null, stderr: 'No conversation found with session ID: old' } }, { events: pong })
    await svc.send(c.id, 'make a routine')
    await svc.send(c.id, 'tick', [], undefined, undefined, undefined, undefined, true)
    expect(calls).toHaveLength(3)
    expect(owners).toEqual([
      { chatId: c.id, writable: true },
      { chatId: c.id, writable: true },
      { chatId: c.id, writable: false }
    ])
    expect(sides).toEqual([false, false, false])
    for (const call of calls) {
      expect(mcpConfigs(call.args)).toEqual([AUTO_CONFIG])
      // The delete ask rules, as the CLI's one --settings.
      expect(settingsOf(call.args).permissions?.ask).toEqual([...CONFIRM_ONLY_TOOLS])
      expect(call.env).toMatchObject({ ZUMIBOT_AUTOMATIONS_IPC: '/tmp/private-automation-ipc' })
      // The system prompt is not changed by the bridge.
      expect(call.args).not.toContain('--append-system-prompt')
    }
    expect(calls.map((call) => call.env?.ZUMIBOT_AUTOMATIONS_CAPABILITY)).toEqual(['auto-cap-1', 'auto-cap-2', 'auto-cap-3'])
    expect(disposed).toBe(3)
    // Only in the spawn: a side run built from the base keeps its own settings.
    expect(svc.sideBase(c.id, 'zumi-bot')!.args.extraArgs).not.toContain('--settings')
  })

  it('its server comes after the to-do and vault bridges and before the desktop, and its rules join the one --settings', async () => {
    const TODO = '{"mcpServers":{"zumibot_todos":{"type":"stdio"}}}'
    const VAULT = '{"mcpServers":{"zumibot_vault":{"type":"stdio"}}}'
    const GUARD = vaultGuardSettings({
      keyFile: '/home/u/.config/zumibot-vault/vault.key',
      vaultFile: '/home/u/.local/share/zumibot/vault.json',
      home: '/home/u'
    })
    svc = makeService({
      automationTurns: automationTurns(),
      vaultGuard: GUARD,
      tmp: new ChatTmp(join(dir, 'claude-tmp')),
      pauseHook: { settings: pauseSettings({ node: '/opt/node', entry: '/opt/pauseHook.mjs', electronNode: false }) },
      todoTurns: { create: () => ({ mcp: NO_MCP, args: ['--mcp-config', TODO], env: {}, dispose: () => {} }) },
      vaultTurns: { create: () => ({ mcp: NO_MCP, args: ['--mcp-config', VAULT], env: {}, dispose: () => {} }) },
      desktopTurns: {
        plan: async () => ({ profileId: 'desktop-profile' }),
        create: async () => ({
          mcp: NO_MCP,
          args: ['--mcp-config', 'desktop-config', '--settings', JSON.stringify({ permissions: { ask: DESKTOP_ASK_RULES } })],
          env: {},
          prompt: '',
          dispose: async () => {}
        })
      }
    })
    const c = await store.create('zumi-bot', dir)
    await svc.send(c.id, 'make a routine')
    expect(mcpConfigs(calls[0].args)).toEqual([TODO, VAULT, AUTO_CONFIG, 'desktop-config'])
    const merged = settingsOf(calls[0].args)
    expect(merged.permissions?.ask).toEqual([...CONFIRM_ONLY_TOOLS, ...DESKTOP_ASK_RULES])
    expect(merged.permissions?.deny).toContain(KEY_DIR_RULE)
    expect(merged.hooks?.PreToolUse?.map((h) => h.matcher)).toEqual(['*', 'Bash'])
  })

  it("another agent's turn and a Compact get no bridge", async () => {
    const other = await store.create('helper', dir)
    await svc.send(other.id, 'hi')
    const c = await store.create('zumi-bot', dir)
    await svc.send(c.id, 'hi')
    scripts.push({ events: [{ kind: 'init', sessionId: 's1' }, okResult] })
    await svc.compact(c.id, '')
    expect(calls).toHaveLength(3)
    expect(calls[2].stdin).toBe('/compact')
    for (const call of [calls[0], calls[2]]) {
      expect(mcpConfigs(call.args)).not.toContain(AUTO_CONFIG)
      expect(call.args).not.toContain('--settings')
      expect(call.env?.ZUMIBOT_AUTOMATIONS_CAPABILITY).toBeUndefined()
    }
    expect(owners).toEqual([{ chatId: c.id, writable: true }])
    expect(svc.sideBase(other.id, 'helper')!.browser).toBe(false)
  })

  // Zumi Bot never joins a room, so this is defence in depth: a turn with an author is a room member's.
  it('a room member turn gets no bridge, even one run as Zumi Bot', async () => {
    const c = await store.create('zumi-bot', dir)
    const r = svc.claim(c.id)
    let items: ChatItem[] = []
    await svc.agentTurn(
      c.id,
      r,
      {
        agentName: 'zumi-bot',
        author: 'zumi-bot',
        sessionId: null,
        prompt: 'go',
        seedPrompt: () => 'seed',
        extraArgs: [],
        disallowedTools: [],
        allowScope: `${c.id}:zumi-bot`,
        saveSession: async () => {}
      },
      {
        get: () => items,
        set: (next) => {
          items = next
        }
      }
    )
    svc.release(c.id, r)
    expect(calls).toHaveLength(1)
    expect(mcpConfigs(calls[0].args)).not.toContain(AUTO_CONFIG)
    expect(calls[0].env?.ZUMIBOT_AUTOMATIONS_CAPABILITY).toBeUndefined()
    expect(owners).toEqual([])
  })

  it("a routine's message from the task tray is read-only; the user's own is writable", async () => {
    const queue = new TaskQueue({
      store,
      chats: svc,
      groups: { send: async () => {}, rerun: async () => {}, compact: async () => {}, requestPause: () => false, resume: async () => {} },
      files: { commit: async () => [], removeFiles: async () => {} },
      push: () => {},
      now: () => 5000,
      newId: () => `q${++n}`
    })
    const c = await store.create('zumi-bot', dir)
    await queue.submit(c.id, 'tick', [], undefined, 'm1', undefined, undefined, 'routine')
    await vi.waitFor(() => expect(owners).toHaveLength(1))
    await vi.waitFor(() => expect(svc.isRunning(c.id)).toBe(false))
    await queue.submit(c.id, 'make a routine', [])
    await vi.waitFor(() => expect(owners).toHaveLength(2))
    expect(owners.map((o) => o.writable)).toEqual([false, true])
  })

  it('a save or a list is allowed with no card, rule or risk hint, in manual mode too', async () => {
    mode = 'manual'
    const risk = vi.fn(async () => null)
    svc = makeService({ automationTurns: automationTurns(), approvalRisk: risk })
    const c = await store.create('zumi-bot', dir)
    const input = { routine: { name: 'Daily' } }
    const LIST = `${AUTOMATION_PREFIX}routines_list`
    const { p } = await hold(c.id, [
      { kind: 'toolUse', id: 'save-tool', name: SAVE, input },
      req('save-permission', SAVE, input, 'save-tool'),
      req('list-permission', LIST)
    ])
    expect(sent).toEqual([allowResponse('save-permission', input), allowResponse('list-permission', {})])
    expect(svc.pendingCount(c.id)).toBe(0)
    expect(pushes.some((x) => x.kind === 'approvals')).toBe(false)
    svc.stop(c.id)
    await p
    expect(await approvalsIn(c.id)).toEqual([])
    expect((await itemsOf(c.id)).find((i) => i.type === 'tool')).toMatchObject({ name: SAVE, input })
    expect(risk).not.toHaveBeenCalled()
    expect(rules.added).toEqual([])
  })

  it('a delete always asks: chat memory and an agent rule holding it are passed over, and no risk hint is asked', async () => {
    const risk = vi.fn(async () => null)
    svc = makeService({ automationTurns: automationTurns(), approvalRisk: risk })
    const c = await store.create('zumi-bot', dir)
    // No delete card can make either; an older build or a hand-edited approvals.json could have left them.
    chatMemory().set(c.id, new Set([allowKey(DELETE, del)]))
    rules.add('zumi-bot', ruleOf(DELETE, del))
    rules.added.length = 0
    const { p } = await hold(c.id, [
      { kind: 'toolUse', id: 'del-tool', name: DELETE, input: del },
      req('del-permission', DELETE, del, 'del-tool')
    ])
    expect(sent).toEqual([])
    expect(svc.pendingCount(c.id)).toBe(1)
    await tick()
    expect((await approvalsIn(c.id)).map((i) => i.status)).toEqual(['pending'])
    expect(risk).not.toHaveBeenCalled()
    svc.stop(c.id)
    await p
  })

  it('Allow for this chat or Allow always on a delete card allows it once and remembers nothing', async () => {
    const c = await store.create('zumi-bot', dir)
    const { p } = await hold(c.id, [req('d1', DELETE, del)])
    svc.answer(c.id, 'd1', 'allow-agent')
    expect(sent).toEqual([allowResponse('d1', del)])
    expect(rules.added).toEqual([])
    emit(req('d2', DELETE, del))
    expect(svc.pendingCount(c.id)).toBe(1)
    svc.answer(c.id, 'd2', 'allow-chat')
    expect(chatMemory().get(c.id)?.size ?? 0).toBe(0)
    emit(req('d3', DELETE, del))
    expect(sent).toEqual([allowResponse('d1', del), allowResponse('d2', del)])
    expect(svc.pendingCount(c.id)).toBe(1)
    svc.stop(c.id)
    await p
    expect((await approvalsIn(c.id)).map((i) => i.status)).toEqual(['allowed-once', 'allowed-once', 'unanswered'])
    expect(rules.added).toEqual([])
  })

  it('a turn the user did not type is refused a delete before any card', async () => {
    const c = await store.create('zumi-bot', dir)
    const { p } = await hold(
      c.id,
      [{ kind: 'toolUse', id: 'del-tool', name: DELETE, input: del }, req('del-permission', DELETE, del, 'del-tool')],
      true
    )
    expect(sent).toEqual([denyResponse('del-permission', WRITE_REFUSED)])
    expect(svc.pendingCount(c.id)).toBe(0)
    expect(pushes.some((x) => x.kind === 'approvals')).toBe(false)
    svc.stop(c.id)
    await p
    expect(await approvalsIn(c.id)).toEqual([])
  })

  it("Zumi Bot's side run gets a read-only turn of its own without --settings; another agent's gets none", async () => {
    const c = await store.create('zumi-bot', dir)
    await svc.send(c.id, 'hello')
    const base = svc.sideBase(c.id, 'zumi-bot')!
    expect(base.browser).toBe(true)
    const turn = (await svc.sideBrowser(c.id, 'zumi-bot'))!
    expect(owners).toEqual([
      { chatId: c.id, writable: true },
      { chatId: c.id, writable: false }
    ])
    expect(sides).toEqual([false, true])
    expect(turn.args).toEqual(['--mcp-config', AUTO_CONFIG])
    // The same tool definitions as the main run.
    expect(mcpConfigs(turn.args)).toEqual(mcpConfigs(calls[0].args))
    expect(turn.env).toMatchObject({
      ZUMIBOT_AUTOMATIONS_CAPABILITY: 'auto-cap-2',
      ZUMIBOT_AUTOMATIONS_IPC: '/tmp/private-automation-ipc'
    })
    // A side run redacts the merged env's values like the main run's.
    const values = new Map<string, string>()
    notePrivateValues(values, 'browser', turn.env)
    expect([...values.keys()]).toEqual(expect.arrayContaining(['auto-cap-2', '/tmp/private-automation-ipc']))
    await turn.dispose()
    expect(disposed).toBe(2)
    const other = await store.create('helper', dir)
    await svc.send(other.id, 'hello')
    expect(await svc.sideBrowser(other.id, 'helper')).toBeNull()
    expect(owners).toHaveLength(2)
  })

  it('without the bridge, a tool of that name asks like any other', async () => {
    svc = makeService()
    const c = await store.create('zumi-bot', dir)
    const { p } = await hold(c.id, [req('save-permission', SAVE, {})])
    expect(sent).toEqual([])
    expect(svc.pendingCount(c.id)).toBe(1)
    svc.stop(c.id)
    await p
  })

  it('a bridge that fails to start costs the run only the tools, and its error is not logged', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    svc = makeService({
      automationTurns: {
        create: () => {
          throw new Error('EACCES /tmp/cb-r-x/s')
        }
      }
    })
    const c = await store.create('zumi-bot', dir)
    await svc.send(c.id, 'go')
    expect(calls[0].args).not.toContain('--settings')
    expect(mcpConfigs(calls[0].args)).toEqual([])
    expect((await itemsOf(c.id)).map((i) => i.type)).toEqual(['user', 'assistant'])
    const logged = log.mock.calls.flat().join(' ')
    expect(logged).toContain('automation tools unavailable for this run')
    expect(logged).not.toContain('/tmp/cb-r-x')
    log.mockRestore()
  })

  it('the capability env values never appear in an error item', async () => {
    const c = await store.create('zumi-bot', dir)
    scripts.push({ outcome: { spawnError: 'spawn failed: auto-cap-1 at /tmp/private-automation-ipc', result: null } })
    await svc.send(c.id, 'go')
    const text = JSON.stringify(await itemsOf(c.id))
    expect(text).toContain('spawn failed')
    for (const secret of ['auto-cap-1', '/tmp/private-automation-ipc']) expect(text).not.toContain(secret)
    expect(disposed).toBe(1)
  })
})

describe('workflow chats', () => {
  it('workflow chat turn appends workflowSystem and ends with workflow flag', async () => {
    const ends: TurnEnd[] = []
    svc = makeService({ onTurnEnd: (e) => ends.push(e) })
    const c = await store.create('helper', dir)
    await store.update(c.id, { workflow: { workflowId: 'w1', runId: 'r1', stepId: 's1', name: 'W' } })
    await svc.send(c.id, 'hi')
    expect(argAfter(calls[0], '--append-system-prompt')).toContain(workflowSystem('W'))
    expect(workflowSystem('W')).toContain('This turn is a step of the workflow "W"')
    expect(ends).toEqual([{ chatId: c.id, agent: 'helper', outcome: 'ok', reply: expect.any(String), workflow: true }])
    // A plain chat gets neither.
    const plain = await store.create('helper', dir)
    await svc.send(plain.id, 'hi')
    expect(argAfter(calls[1], '--append-system-prompt') ?? '').not.toContain('step of the workflow')
    expect(ends[1]).toEqual({ chatId: plain.id, agent: 'helper', outcome: 'ok', reply: expect.any(String) })
  })

  it('a kept workflow chat keeps the workflow paragraph but its turn end is not silent', async () => {
    const ends: TurnEnd[] = []
    svc = makeService({ onTurnEnd: (e) => ends.push(e) })
    const c = await store.create('helper', dir)
    await store.update(c.id, { workflow: { workflowId: 'w1', runId: 'r1', stepId: 's1', name: 'W', keep: true } })
    await svc.send(c.id, 'hi')
    expect(argAfter(calls[0], '--append-system-prompt')).toContain(workflowSystem('W'))
    expect(ends).toEqual([{ chatId: c.id, agent: 'helper', outcome: 'ok', reply: expect.any(String) }])
  })

  it('a step test chat gets the workflow paragraph too, every turn, but no workflow link or silent end', async () => {
    // Its input may come from a real run's visit (a webhook body, an agent's output), so the material rule must hold.
    const ends: TurnEnd[] = []
    svc = makeService({ onTurnEnd: (e) => ends.push(e) })
    const c = await store.create('helper', dir)
    await store.update(c.id, { workflowTest: 'W' })
    await svc.send(c.id, 'hi')
    await svc.send(c.id, 'and again')
    for (const call of calls) expect(argAfter(call, '--append-system-prompt').startsWith(workflowSystem('W'))).toBe(true)
    expect(ends).toEqual([
      { chatId: c.id, agent: 'helper', outcome: 'ok', reply: expect.any(String) },
      { chatId: c.id, agent: 'helper', outcome: 'ok', reply: expect.any(String) }
    ])
  })
})

describe('voice chats', () => {
  // Voice only marks the chat; its turns, rules and cards are an ordinary chat's.
  const req = (requestId: string, toolName: string, input: unknown = {}): RunEvent => ({
    kind: 'permissionRequest',
    requestId,
    toolName,
    input,
    description: 'd',
    reason: 'r',
    toolUseId: null
  })
  const chatRules = () => (svc as unknown as { allowed: Map<string, Set<string>> }).allowed

  it('a voice chat run has no extra prompt or settings, and a saved rule still answers its change call', async () => {
    const c = await store.create('helper', dir)
    await store.update(c.id, { voice: true })
    await svc.send(c.id, 'hi')
    expect(calls[0].args).not.toContain('--append-system-prompt')
    expect(calls[0].args).not.toContain('--settings')
    const input = { to: 'a@b.c' }
    chatRules().set(c.id, new Set([allowKey('mcp__gmail__send_message', input)]))
    let ready!: () => void
    const emitted = new Promise<void>((resolve) => {
      ready = resolve
    })
    scripts.push({ hang: true, events: [req('r1', 'mcp__gmail__send_message', input)], ready })
    const p = svc.send(c.id, 'go')
    await emitted
    expect((await itemsOf(c.id)).filter((i) => i.type === 'approval').map((i) => (i as { status: string }).status)).toEqual([
      'auto-allowed'
    ])
    svc.stop(c.id)
    await p
  })
})

describe('dispatched agents', () => {
  const nested = (): RunEvent[] =>
    readFileSync(fileURLToPath(new URL('../fixtures/stream/dispatch-nested.jsonl', import.meta.url)), 'utf8')
      .split('\n')
      .flatMap(parseLine)
  let dispatch: DispatchService
  let changed: string[]
  beforeEach(() => {
    changed = []
    dispatch = new DispatchService({ store, onChanged: (id) => changed.push(id), now: () => 5000, privateTool: () => null, delayMs: 5 })
    // As app.ts wires it: every saved item list tells the service which Agent rows are visible.
    store.setItemsListener((id, items) => dispatch.noteItems(id, items))
  })
  afterEach(() => {
    store.setItemsListener(null)
  })

  it('records dispatches of a turn', async () => {
    svc = makeService({ dispatch })
    const c = await store.create('helper', dir)
    scripts.push({ events: nested() })
    await svc.send(c.id, 'go')
    const list = await dispatch.list(c.id)
    expect(list.map((s) => [s.id, s.status, s.parent])).toEqual([
      ['toolu_A', 'done', null],
      ['toolu_B', 'failed', null],
      ['toolu_N', 'done', 'toolu_A']
    ])
    expect(list[0].member).toBeUndefined()
    expect(changed).toContain(c.id)
    // Nothing of the subagents reaches the chat items: the Agent rows and the agent's own closing text only.
    expect((await itemsOf(c.id)).map((i) => i.type)).toEqual(['user', 'tool', 'tool', 'assistant'])
  })

  it('stopped turn marks running entries stopped', async () => {
    svc = makeService({ dispatch })
    const c = await store.create('helper', dir)
    const all = nested()
    // Before the CLI says A completed: A and B still run, the nested one has ended.
    const cut = all.slice(
      0,
      all.findIndex((e) => e.kind === 'taskUpdated' && e.taskId === 'ta')
    )
    let ready: () => void = () => {}
    const reached = new Promise<void>((r) => {
      ready = r
    })
    scripts.push({ events: cut, hang: true, ready })
    const sending = svc.send(c.id, 'go')
    await reached
    expect((await dispatch.list(c.id)).map((s) => s.status)).toEqual(['running', 'running', 'done'])
    svc.stop(c.id)
    await sending
    expect((await dispatch.list(c.id)).map((s) => [s.id, s.status])).toEqual([
      ['toolu_A', 'stopped'],
      ['toolu_B', 'stopped'],
      ['toolu_N', 'done']
    ])
  })

  it('a failing dispatch store never changes how the turn ends', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = new DispatchService({
      store: {
        ...store,
        loadDispatch: (id: string) => store.loadDispatch(id),
        loadItems: (id: string) => store.loadItems(id),
        updateDispatch: async () => {
          throw Object.assign(new Error('x'), { code: 'EIO' })
        }
      },
      onChanged: () => {},
      now: () => 5000,
      privateTool: () => null,
      delayMs: 5
    })
    svc = makeService({ dispatch: broken })
    const c = await store.create('helper', dir)
    scripts.push({ events: nested() })
    await svc.send(c.id, 'go')
    const items = await itemsOf(c.id)
    expect(items.at(-1)).toMatchObject({ type: 'assistant', text: 'Both reviews ran.' })
    log.mockRestore()
  })
})

describe('pause', () => {
  const settings = pauseSettings({ node: '/opt/node', entry: '/opt/pauseHook.mjs', electronNode: false })
  const hookCommand = JSON.parse(settings).hooks.PreToolUse[0].hooks[0].command as string
  let tmp: ChatTmp
  let ends: TurnEnd[]
  const withPause = (extra: Partial<ChatServiceDeps> = {}) => {
    tmp = new ChatTmp(join(dir, 'claude-tmp'))
    ends = []
    svc = makeService({ tmp, pauseHook: { settings }, onTurnEnd: (e) => ends.push(e), ...extra })
  }
  const settingsOf = (args: string[]) => {
    expect(args.filter((a) => a === '--settings')).toHaveLength(1)
    return JSON.parse(args[args.indexOf('--settings') + 1]) as {
      hooks?: { PreToolUse?: { matcher: string; hooks: { command: string }[] }[] }
      permissions?: { ask?: string[] }
    }
  }
  const hookIn = (args: string[]) =>
    (settingsOf(args).hooks?.PreToolUse ?? []).some((h) => h.matcher === '*' && h.hooks.some((x) => x.command === hookCommand))
  const shape = (items: ChatItem[]) => items.map((i) => (i.type === 'notice' ? `notice:${i.kind}` : i.type))
  // message: the API response the call came in (absent, as in most fakes: a call after a result starts a new response).
  const bash = (id: string, message?: string): RunEvent => ({
    kind: 'toolUse',
    id,
    name: 'Bash',
    input: { command: 'ls' },
    ...(message ? { message } : {})
  })
  const blocked = (id: string): RunEvent => ({
    kind: 'toolResult',
    toolUseId: id,
    content: `PreToolUse:Bash hook error: [sh]: ${PAUSE_BLOCK_TEXT}`,
    isError: true
  })
  // Three responses, each after the agent saw the last one's block.
  const threeBlocked = (): RunEvent[] => ['b1', 'b2', 'b3'].flatMap((id) => [bash(id), blocked(id)])
  // A run that keeps going until stop() or script.end(): the safety cap is the only thing here that stops it.
  const hang = (chatId: string, events: RunEvent[]) => {
    let ready!: () => void
    const reached = new Promise<void>((resolve) => {
      ready = resolve
    })
    const script: Script = { hang: true, events, ready }
    scripts.push(script)
    const p = svc.send(chatId, 'go')
    return { p, reached, script }
  }
  const wrapUp = (script: Script) => {
    emit({ kind: 'assistantText', text: 'Paused before step 3; next is step 3.' })
    emit(okResult)
    script.end!()
  }
  const pausing = async (chatId: string) => {
    await store.update(chatId, { pause: 'pausing' })
    await svc.setPauseFlag(chatId, true)
  }

  it("gives a main run the hook in its one --settings and the chat's flag path in env", async () => {
    withPause()
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'ping')
    expect(hookIn(calls[0].args)).toBe(true)
    expect(calls[0].env?.ZUMIBOT_PAUSE_FILE).toBe(tmp.pauseFlagOf(c.id))
    // The hook is added only to the spawn, so a side run built from the base stays as it was.
    expect(svc.sideBase(c.id, 'helper')!.args.extraArgs).not.toContain('--settings')
  })

  it('a desktop agent keeps its 8 ask rules in that same one --settings', async () => {
    const desktopTurn: DesktopTurn = {
      mcp: NO_MCP,
      args: ['--mcp-config', 'desktop-config', '--settings', JSON.stringify({ permissions: { ask: DESKTOP_ASK_RULES } })],
      env: {},
      prompt: 'Desktop prompt',
      dispose: async () => {}
    }
    withPause({ desktopTurns: { plan: async () => ({ profileId: 'p' }), create: async () => desktopTurn } })
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'hello')
    expect(settingsOf(calls[0].args).permissions?.ask).toEqual(DESKTOP_ASK_RULES)
    expect(hookIn(calls[0].args)).toBe(true)
  })

  it("a room member run gets the hook and the room's flag", async () => {
    withPause()
    const g = await store.createGroup(['ui', 'wk'], dir)
    const r = svc.claim(g.id)
    let items: ChatItem[] = []
    await svc.agentTurn(
      g.id,
      r,
      {
        agentName: 'ui',
        author: 'ui',
        turnId: 'turn-1',
        sessionId: null,
        prompt: 'go',
        seedPrompt: () => 'seed',
        extraArgs: [],
        disallowedTools: [],
        allowScope: `${g.id}:ui`,
        saveSession: async () => {}
      },
      {
        get: () => items,
        set: (next) => {
          items = next
        }
      }
    )
    svc.release(g.id, r)
    expect(hookIn(calls[0].args)).toBe(true)
    expect(calls[0].env?.ZUMIBOT_PAUSE_FILE).toBe(tmp.pauseFlagOf(g.id))
  })

  it('a compact run gets no hook and no flag path', async () => {
    withPause()
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'ping')
    await svc.compact(c.id, '')
    expect(calls[1].stdin).toBe('/compact')
    expect(calls[1].args).not.toContain('--settings')
    expect(calls[1].env?.ZUMIBOT_PAUSE_FILE).toBeUndefined()
  })

  it('without the hook dep a run is exactly as before', async () => {
    tmp = new ChatTmp(join(dir, 'claude-tmp'))
    svc = makeService({ tmp })
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'ping')
    expect(calls[0].args).not.toContain('--settings')
    expect(calls[0].env?.ZUMIBOT_PAUSE_FILE).toBeUndefined()
  })

  it('can pause only with the hook and the temp folder that holds its flag', async () => {
    const c = await store.create('helper', dir)
    const g = await store.createGroup(['ui', 'wk'], dir)
    for (const id of [c.id, g.id]) {
      expect(await makeService().canPause(id)).toBe(false)
      expect(await makeService({ tmp: new ChatTmp(join(dir, 'claude-tmp')) }).canPause(id)).toBe(false)
      expect(await makeService({ pauseHook: { settings } }).canPause(id)).toBe(false)
      withPause()
      expect(await svc.canPause(id)).toBe(true)
    }
  })

  it('setPauseFlag writes an empty owner-only flag and removes it, a missing one too', async () => {
    withPause()
    const c = await store.create('helper', dir)
    await svc.setPauseFlag(c.id, true)
    const flag = tmp.pauseFlagOf(c.id)
    expect(await fs.readFile(flag, 'utf8')).toBe('')
    if (process.platform !== 'win32') expect(statSync(flag).mode & 0o777).toBe(0o600)
    await svc.setPauseFlag(c.id, false)
    expect(existsSync(flag)).toBe(false)
    await expect(svc.setPauseFlag(c.id, false)).resolves.toBeUndefined()
  })

  it('a stale flag (a crash mid-pause) is gone before a later run starts, so nothing blocks it', async () => {
    withPause()
    const c = await store.create('helper', dir)
    const flag = tmp.pauseFlagOf(c.id)
    await tmp.ensure(c.id)
    await fs.writeFile(flag, '')
    let atSpawn: boolean | null = null
    scripts.push({
      events: pong,
      act: async () => {
        atSpawn = existsSync(flag)
      }
    })
    await svc.send(c.id, 'ping')
    expect(atSpawn).toBe(false)
    expect((await store.get(c.id))?.pause).toBeUndefined()
    expect((await itemsOf(c.id)).map((i) => i.type)).toEqual(['user', 'assistant'])
  })

  it('a pausing chat keeps its flag when an attempt starts (a reseed retry)', async () => {
    withPause()
    const c = await store.create('helper', dir)
    await store.update(c.id, { sessionId: 'old' })
    const flag = tmp.pauseFlagOf(c.id)
    const seen: boolean[] = []
    scripts.push(
      {
        outcome: { result: null, stderr: 'No conversation found with session ID: old' },
        act: async () => {
          await pausing(c.id)
          seen.push(existsSync(flag))
        }
      },
      {
        events: pong,
        act: async () => {
          seen.push(existsSync(flag))
        }
      }
    )
    await svc.send(c.id, 'go')
    expect(calls).toHaveLength(2)
    expect(seen).toEqual([true, true])
  })

  it('a Stop pressed while an attempt sets up (the flag check, the folder) never spawns the CLI', async () => {
    let open!: () => void
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const real = new ChatTmp(join(dir, 'claude-tmp'))
    svc = makeService({
      tmp: {
        ensure: async (id) => {
          await gate
          return real.ensure(id)
        },
        pauseFlagOf: (id) => real.pauseFlagOf(id)
      },
      pauseHook: { settings }
    })
    const c = await store.create('helper', dir)
    const p = svc.send(c.id, 'go')
    await tick()
    svc.stop(c.id)
    open()
    await p
    expect(calls).toHaveLength(0)
    expect(shape(await itemsOf(c.id))).toEqual(['user', 'notice:stopped'])
  })

  it('finishPause does nothing for a chat that is not pausing', async () => {
    withPause()
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'ping')
    expect(await svc.finishPause(c.id)).toBeNull()
    expect(shape(await itemsOf(c.id))).toEqual(['user', 'assistant'])
  })

  it('a clean pause end: the blocked agent wraps up, then the Paused notice, the paused state, held tasks and no flag', async () => {
    withPause()
    const c = await store.create('helper', dir)
    await store.addTask(c.id, { id: 'q1', text: 'later', ts: 1 })
    scripts.push({
      act: () => pausing(c.id),
      events: [
        { kind: 'init', sessionId: 's1' },
        bash('t1'),
        blocked('t1'),
        { kind: 'assistantText', text: 'Stopped at step 2; next is step 3.' },
        okResult
      ]
    })
    await svc.send(c.id, 'go')
    expect(shape(await itemsOf(c.id))).toEqual(['user', 'tool', 'assistant', 'notice:userPaused'])
    expect((await itemsOf(c.id)).at(-1)).toMatchObject({ text: 'Paused. Press Resume to continue.' })
    const meta = (await store.get(c.id))!
    expect(meta).toMatchObject({ pause: 'paused', held: true, inFlight: false })
    expect(meta.tasks?.map((t) => t.id)).toEqual(['q1'])
    expect(existsSync(tmp.pauseFlagOf(c.id))).toBe(false)
    // The tabs learn of both: the notice and the paused state.
    const view = pushes.reduce(applyPush, emptyChatView)
    expect(shape(view.items)).toEqual(shape(await itemsOf(c.id)))
    expect(pushes.filter((p) => p.kind === 'meta').at(-1)).toMatchObject({ meta: { pause: 'paused' } })
    expect(ends).toEqual([{ chatId: c.id, agent: 'helper', outcome: 'ok', reply: expect.any(String) }])
    expect(idled).toEqual([[c.id, false]])
  })

  it('Stop while pausing: stopped, then the Paused notice, and the held tray starts nothing', async () => {
    withPause({ onIdle: (id) => queue.idle(id) })
    const queue = new TaskQueue({
      store,
      chats: svc,
      groups: { send: async () => {}, rerun: async () => {}, compact: async () => {}, requestPause: () => false, resume: async () => {} },
      files: { commit: async () => [], removeFiles: async () => {} },
      push: () => {},
      now: () => 5000,
      newId: () => 'q'
    })
    const c = await store.create('helper', dir)
    const { p, reached } = hang(c.id, [
      { kind: 'init', sessionId: 's1' },
      { kind: 'toolUse', id: 'ag', name: 'Agent', input: { description: 'scan' } }
    ])
    await reached
    await store.addTask(c.id, { id: 'q1', text: 'later', ts: 1 })
    await pausing(c.id)
    svc.stop(c.id)
    await p
    await tick()
    expect(shape(await itemsOf(c.id))).toEqual(['user', 'tool', 'notice:stopped', 'notice:userPaused'])
    expect(await store.get(c.id)).toMatchObject({ pause: 'paused', held: true, tasks: [{ id: 'q1' }] })
    expect(calls).toHaveLength(1)
    expect(existsSync(tmp.pauseFlagOf(c.id))).toBe(false)
  })

  it('three calls blocked in one response are one round: no stop, and the agent writes its status and ends', async () => {
    withPause()
    const c = await store.create('helper', dir)
    await pausing(c.id)
    const { p, reached, script } = hang(c.id, [
      { kind: 'init', sessionId: 's1' },
      bash('b1'),
      bash('b2'),
      bash('b3'),
      blocked('b1'),
      blocked('b2'),
      blocked('b3')
    ])
    await reached
    await tick()
    expect(svc.isRunning(c.id)).toBe(true)
    wrapUp(script)
    await p
    expect(shape(await itemsOf(c.id))).toEqual(['user', 'tool', 'tool', 'tool', 'assistant', 'notice:userPaused'])
    expect(await store.get(c.id)).toMatchObject({ pause: 'paused', inFlight: false })
    expect(ends).toEqual([{ chatId: c.id, agent: 'helper', outcome: 'ok', reply: expect.any(String) }])
  })

  it('a response whose results arrive between its own calls (the CLI runs tools as they stream) is still one round', async () => {
    withPause()
    const c = await store.create('helper', dir)
    await pausing(c.id)
    const { p, reached, script } = hang(c.id, [
      { kind: 'init', sessionId: 's1' },
      ...['b1', 'b2', 'b3'].flatMap((id) => [bash(id, 'msg_1'), blocked(id)])
    ])
    await reached
    await tick()
    expect(svc.isRunning(c.id)).toBe(true)
    wrapUp(script)
    await p
    expect(shape(await itemsOf(c.id))).toEqual(['user', 'tool', 'tool', 'tool', 'assistant', 'notice:userPaused'])
  })

  it('the safety cap: blocked calls in three responses, each after the agent saw a block, stop the run on the third, with no stopped notice', async () => {
    withPause()
    const c = await store.create('helper', dir)
    await pausing(c.id)
    const { p } = hang(c.id, [{ kind: 'init', sessionId: 's1' }, ...threeBlocked()])
    await p // the hanging run ends only through stop()
    expect(shape(await itemsOf(c.id))).toEqual(['user', 'tool', 'tool', 'tool', 'notice:userPaused'])
    expect(await store.get(c.id)).toMatchObject({ pause: 'paused', inFlight: false })
    expect(ends).toEqual([{ chatId: c.id, agent: 'helper', outcome: 'ok', reply: expect.any(String) }])
  })

  it('the safety cap counts responses by their API message: two calls of the third one, interleaved with results, stop it once', async () => {
    withPause()
    const c = await store.create('helper', dir)
    await pausing(c.id)
    const { p, reached } = hang(c.id, [
      { kind: 'init', sessionId: 's1' },
      bash('b1', 'msg_1'),
      blocked('b1'),
      bash('b2', 'msg_1'),
      blocked('b2'), // one response
      bash('b3', 'msg_2'),
      blocked('b3')
    ])
    await reached
    await tick()
    expect(svc.isRunning(c.id)).toBe(true) // two rounds so far
    emit(bash('b4', 'msg_3'))
    emit(blocked('b4'))
    await p
    expect(shape(await itemsOf(c.id))).toEqual(['user', 'tool', 'tool', 'tool', 'tool', 'notice:userPaused'])
  })

  it('the safety cap waits for a main call that still runs (parallel calls), and its result alone never stops the run', async () => {
    withPause()
    const c = await store.create('helper', dir)
    await pausing(c.id)
    const { p, reached } = hang(c.id, [{ kind: 'init', sessionId: 's1' }, bash('a'), ...threeBlocked()])
    await reached
    await tick()
    expect(svc.isRunning(c.id)).toBe(true)
    emit({ kind: 'toolResult', toolUseId: 'a', content: 'done', isError: false })
    await tick()
    // The agent gets a request to read that result; only a further block, with nothing open, stops it.
    expect(svc.isRunning(c.id)).toBe(true)
    emit(bash('b4'))
    emit(blocked('b4'))
    await p
    expect(shape(await itemsOf(c.id))).toEqual(['user', 'tool', 'tool', 'tool', 'tool', 'tool', 'notice:userPaused'])
    expect((await itemsOf(c.id))[1]).toMatchObject({ id: 'a', result: 'done', isError: false })
  })

  it('a long dispatch finishing after three blocked rounds does not stop the run by itself, and the agent may then wrap up', async () => {
    const dispatch = new DispatchService({ store, onChanged: () => {}, now: () => 5000, privateTool: () => null, delayMs: 5 })
    withPause({ dispatch })
    const c = await store.create('helper', dir)
    await pausing(c.id)
    const { p, reached, script } = hang(c.id, [
      { kind: 'init', sessionId: 's1' },
      { kind: 'toolUse', id: 'ag', name: 'Agent', input: { description: 'scan', prompt: 'scan the logs' } },
      { kind: 'taskStarted', toolUseId: 'ag', taskId: 'task-1', description: 'scan', subagentType: null, prompt: 'scan the logs' },
      // A subagent's calls are let through by the hook; a blocked-looking one there never counts.
      { kind: 'subToolUse', parent: 'ag', id: 's1', name: 'Bash', input: {}, subagent: null },
      { kind: 'subToolResult', parent: 'ag', toolUseId: 's1', content: PAUSE_BLOCK_TEXT, isError: true },
      ...threeBlocked()
    ])
    await reached
    await tick()
    expect(svc.isRunning(c.id)).toBe(true)
    emit({ kind: 'toolResult', toolUseId: 'ag', content: 'scanned', isError: false })
    await tick()
    expect(svc.isRunning(c.id)).toBe(true)
    wrapUp(script)
    await p
    expect(shape(await itemsOf(c.id))).toEqual(['user', 'tool', 'tool', 'tool', 'tool', 'assistant', 'notice:userPaused'])
    expect((await dispatch.list(c.id)).map((s) => s.status)).toEqual(['done'])
  })

  it('a subagent still running holds the cap even with no main call open', async () => {
    const dispatch = new DispatchService({ store, onChanged: () => {}, now: () => 5000, privateTool: () => null, delayMs: 5 })
    withPause({ dispatch })
    const c = await store.create('helper', dir)
    await pausing(c.id)
    const { p, reached } = hang(c.id, [
      { kind: 'init', sessionId: 's1' },
      { kind: 'toolUse', id: 'ag', name: 'Agent', input: { description: 'review' } },
      { kind: 'subToolUse', parent: 'ag', id: 'n1', name: 'Agent', input: { description: 'nested scan' }, subagent: null },
      // The main call is closed while its nested subagent is still recorded as running.
      { kind: 'toolResult', toolUseId: 'ag', content: 'reviewed', isError: false },
      ...threeBlocked()
    ])
    await reached
    await tick()
    expect(svc.isRunning(c.id)).toBe(true)
    emit({ kind: 'subToolResult', parent: 'ag', toolUseId: 'n1', content: 'scanned', isError: false })
    await tick()
    expect(svc.isRunning(c.id)).toBe(true) // a closing call never triggers the cap
    emit(bash('b4'))
    emit(blocked('b4'))
    await p
    expect(shape(await itemsOf(c.id))).toEqual(['user', 'tool', 'tool', 'tool', 'tool', 'tool', 'notice:userPaused'])
  })

  it('blocked calls inside subagents never count toward the cap', async () => {
    withPause()
    const c = await store.create('helper', dir)
    await pausing(c.id)
    const sub = (id: string): RunEvent[] => [
      { kind: 'subToolUse', parent: 'ag', id, name: 'Bash', input: {}, subagent: null },
      { kind: 'subToolResult', parent: 'ag', toolUseId: id, content: PAUSE_BLOCK_TEXT, isError: true }
    ]
    const { p, reached } = hang(c.id, [{ kind: 'init', sessionId: 's1' }, ...sub('x1'), ...sub('x2'), ...sub('x3'), ...sub('x4')])
    await reached
    await tick()
    expect(svc.isRunning(c.id)).toBe(true)
    svc.stop(c.id)
    await p
  })

  it('outside a pause, an error that quotes the block text never stops the run', async () => {
    withPause()
    const c = await store.create('helper', dir)
    const { p, reached } = hang(c.id, [{ kind: 'init', sessionId: 's1' }, ...threeBlocked()])
    await reached
    await tick()
    expect(svc.isRunning(c.id)).toBe(true)
    svc.stop(c.id)
    await p
    expect(shape(await itemsOf(c.id))).toEqual(['user', 'tool', 'tool', 'tool', 'notice:stopped'])
    expect((await store.get(c.id))?.pause).toBeUndefined()
  })

  it('a pending main-thread approval stays pending at Pause, and answering it sends the allow unchanged', async () => {
    mode = 'manual'
    withPause()
    const c = await store.create('helper', dir)
    const input = { command: 'rm -rf build' }
    const { p, reached } = hang(c.id, [
      { kind: 'init', sessionId: 's1' },
      { kind: 'toolUse', id: 't1', name: 'Bash', input },
      { kind: 'permissionRequest', requestId: 'r1', toolName: 'Bash', input, description: 'd', reason: 'r', toolUseId: 't1' }
    ])
    await reached
    await pausing(c.id)
    await tick()
    expect((await itemsOf(c.id)).find((i) => i.type === 'approval')).toMatchObject({ id: 'r1', status: 'pending' })
    expect(svc.pendingCount(c.id)).toBe(1)
    expect(sent).toEqual([])
    svc.answer(c.id, 'r1', 'allow-once')
    expect(sent).toEqual([allowResponse('r1', input)])
    emit({ kind: 'toolResult', toolUseId: 't1', content: 'removed', isError: false })
    // The allowed call ran; the agent's next call is the one the hook blocks.
    for (const e of threeBlocked()) emit(e)
    await p
    expect(shape(await itemsOf(c.id))).toEqual(['user', 'tool', 'approval', 'tool', 'tool', 'tool', 'notice:userPaused'])
    expect((await itemsOf(c.id)).find((i) => i.type === 'approval')).toMatchObject({ status: 'allowed-once' })
  })
})

describe('lost subagents', () => {
  let dispatch: DispatchService
  const agentCall = (id: string, description: string): RunEvent => ({
    kind: 'toolUse',
    id,
    name: 'Agent',
    input: { description, prompt: `${description}, please` }
  })
  // Two of the agent's own subagents run when Stop is pressed, and one inside the first.
  const running = (): RunEvent[] => [
    { kind: 'init', sessionId: 's1' },
    agentCall('a1', 'scan the logs'),
    agentCall('a2', 'review the diff'),
    { kind: 'subToolUse', parent: 'a1', id: 'n1', name: 'Agent', input: { description: 'grep for errors' }, subagent: null }
  ]
  const NOTE = lostNote(['scan the logs', 'review the diff'])!
  const lostOf = async (id: string) => (await store.get(id))?.lost
  const shape = (items: ChatItem[]) => items.map((i) => (i.type === 'notice' ? `notice:${i.kind}` : i.type))
  beforeEach(() => {
    dispatch = new DispatchService({ store, onChanged: () => {}, now: () => 5000, privateTool: () => null, delayMs: 5 })
    svc = makeService({ dispatch })
  })
  // A turn that runs `events`, then waits until the test ends it.
  const hangingTurn = (chatId: string, events: RunEvent[], text = 'go') => {
    let ready!: () => void
    const reached = new Promise<void>((resolve) => {
      ready = resolve
    })
    const script: Script = { hang: true, events, ready }
    scripts.push(script)
    return { p: svc.send(chatId, text), reached, script }
  }
  const stoppedTurn = async (chatId: string, events: RunEvent[], text = 'go') => {
    const { p, reached } = hangingTurn(chatId, events, text)
    await reached
    svc.stop(chatId)
    await p
  }

  it("a stopped turn stores what its own running subagents were doing, not the nested one's", async () => {
    const c = await store.create('helper', dir)
    await stoppedTurn(c.id, running())
    expect(await lostOf(c.id)).toEqual(['scan the logs', 'review the diff'])
    expect((await dispatch.list(c.id)).map((s) => [s.id, s.status])).toEqual([
      ['a1', 'stopped'],
      ['a2', 'stopped'],
      ['n1', 'stopped']
    ])
    // Never a chat item.
    expect(shape(await itemsOf(c.id))).toEqual(['user', 'tool', 'tool', 'notice:stopped'])
    expect(JSON.stringify(await itemsOf(c.id))).not.toContain('results are lost')
  })

  it('a server shutdown mid-turn (it waits for every run) records what it killed', async () => {
    const c = await store.create('helper', dir)
    const { p, reached } = hangingTurn(c.id, running())
    await reached
    await svc.stopAll()
    await p
    expect(shape(await itemsOf(c.id))).toEqual(['user', 'tool', 'tool', 'notice:interrupted'])
    expect(await lostOf(c.id)).toEqual(['scan the logs', 'review the diff'])
  })

  it('a subagent that returned before the stop is not lost', async () => {
    const c = await store.create('helper', dir)
    await stoppedTurn(c.id, [...running(), { kind: 'toolResult', toolUseId: 'a2', content: 'reviewed', isError: false }])
    expect(await lostOf(c.id)).toEqual(['scan the logs'])
  })

  // CLI 2.1.317's SIGINT first aborts the running query: its Agent calls may come back as errors before it exits.
  const aborted = (id: string): RunEvent => ({
    kind: 'toolResult',
    toolUseId: id,
    content: '[Request interrupted by user for tool use]',
    isError: true
  })
  const stoppedWinding = async (chatId: string, events: RunEvent[], onStop: RunEvent[]) => {
    const { p, reached, script } = hangingTurn(chatId, events)
    script.onStop = onStop
    await reached
    svc.stop(chatId)
    await p
  }

  it('a Stop whose CLI closes the running subagents as failed before it exits still stores them', async () => {
    const c = await store.create('helper', dir)
    await stoppedWinding(c.id, running(), [aborted('a1'), aborted('a2')])
    expect((await dispatch.list(c.id)).map((s) => [s.id, s.status])).toEqual([
      ['a1', 'failed'],
      ['a2', 'failed'],
      ['n1', 'stopped']
    ])
    expect(await lostOf(c.id)).toEqual(['scan the logs', 'review the diff'])
  })

  it('the same when the CLI ends them with task_updated killed', async () => {
    const c = await store.create('helper', dir)
    const started = (toolUseId: string, taskId: string): RunEvent => ({
      kind: 'taskStarted',
      toolUseId,
      taskId,
      description: null,
      prompt: null,
      subagentType: null
    })
    const killed = (taskId: string): RunEvent => ({ kind: 'taskUpdated', taskId, status: 'killed', endTime: 6000 })
    await stoppedWinding(c.id, [...running(), started('a1', 'k1'), started('a2', 'k2')], [killed('k1'), killed('k2')])
    expect((await dispatch.list(c.id)).filter((s) => s.parent === null).map((s) => s.status)).toEqual(['failed', 'failed'])
    expect(await lostOf(c.id)).toEqual(['scan the logs', 'review the diff'])
  })

  it('one that comes back done while the Stop winds down is not lost', async () => {
    const c = await store.create('helper', dir)
    await stoppedWinding(c.id, running(), [{ kind: 'toolResult', toolUseId: 'a2', content: 'reviewed', isError: false }, aborted('a1')])
    expect(await lostOf(c.id)).toEqual(['scan the logs'])
  })

  it('one the agent starts while the Stop winds down counts when it is still running at the end', async () => {
    const c = await store.create('helper', dir)
    await stoppedWinding(c.id, running(), [aborted('a1'), agentCall('a3', 'write the notes'), agentCall('a4', 'tidy up'), aborted('a4')])
    expect(await lostOf(c.id)).toEqual(['scan the logs', 'review the diff', 'write the notes'])
  })

  it('a stop with no subagent running stores nothing', async () => {
    const c = await store.create('helper', dir)
    await stoppedTurn(c.id, [{ kind: 'init', sessionId: 's1' }])
    expect(await lostOf(c.id)).toBeUndefined()
  })

  it.each([
    [
      'ends with its result',
      {
        events: [
          { kind: 'init', sessionId: 's1' },
          agentCall('a1', 'scan the logs'),
          { kind: 'assistantText', text: 'done' },
          okResult
        ] as RunEvent[]
      }
    ],
    [
      'fails',
      {
        events: [{ kind: 'init', sessionId: 's1' }, agentCall('a1', 'scan the logs')] as RunEvent[],
        outcome: { exitCode: 1, result: null, stderr: 'boom' }
      }
    ]
  ])('a turn that %s with a subagent still marked running records nothing', async (_, script) => {
    const c = await store.create('helper', dir)
    scripts.push(script)
    await svc.send(c.id, 'go')
    expect((await dispatch.list(c.id))[0].status).toBe('interrupted')
    expect(await lostOf(c.id)).toBeUndefined()
  })

  it("the next turn's message ends with the note, after the to-do note; lost is gone once that run starts, and it is told once", async () => {
    const todos = new TodoService({ store, now: () => 5000, newId: () => 'td1', onChanged: () => {} })
    svc = makeService({ dispatch, todos })
    const c = await store.create('helper', dir)
    await stoppedTurn(c.id, running())
    await todos.userAdd('Call Homam', c.id)
    const { p, reached, script } = hangingTurn(c.id, [{ kind: 'init', sessionId: 's1' }], 'continue')
    await reached
    await tick()
    expect(svc.isRunning(c.id)).toBe(true)
    expect(await lostOf(c.id)).toBeUndefined()
    emit({ kind: 'assistantText', text: 'Running them again.' })
    emit(okResult)
    script.end!()
    await p
    expect(calls[1].args).toContain('--resume')
    expect(calls[1].args).not.toContain('--resume-session-at')
    const stdin = calls[1].stdin as string
    expect(stdin).toMatch(/^continue\n\nThe user's task board[^]*Call Homam/)
    expect(stdin.endsWith(`\n\n${NOTE}`)).toBe(true)
    expect(stdin.indexOf("The user's task board")).toBeLessThan(stdin.indexOf(NOTE))
    expect(JSON.stringify(await itemsOf(c.id))).not.toContain('results are lost')
    await svc.send(c.id, 'more')
    expect(calls[2].stdin).toBe('more')
  })

  it('without a to-do list the note follows the message itself', async () => {
    const c = await store.create('helper', dir)
    await stoppedTurn(c.id, running())
    await svc.send(c.id, 'continue')
    expect(calls[1].stdin).toBe(`continue\n\n${NOTE}`)
    expect(await lostOf(c.id)).toBeUndefined()
  })

  it('a run that never reached the CLI keeps the note for the next one', async () => {
    const c = await store.create('helper', dir)
    await stoppedTurn(c.id, running())
    scripts.push({ events: [], outcome: { spawnError: 'Folder not found: /gone', exitCode: null, result: null } })
    await svc.send(c.id, 'continue')
    expect(await lostOf(c.id)).toEqual(['scan the logs', 'review the diff'])
    await svc.send(c.id, 'continue')
    expect(calls[2].stdin).toBe(`continue\n\n${NOTE}`)
    expect(await lostOf(c.id)).toBeUndefined()
  })

  it('the turn told of them, stopped again with nothing running, leaves nothing', async () => {
    const c = await store.create('helper', dir)
    await stoppedTurn(c.id, running())
    await stoppedTurn(c.id, [{ kind: 'init', sessionId: 's1' }], 'continue')
    expect(calls[1].stdin).toBe(`continue\n\n${NOTE}`)
    expect(await lostOf(c.id)).toBeUndefined()
  })

  it('a cut run (an Edit of the stopped message) adds no note and clears lost', async () => {
    const c = await store.create('helper', dir)
    scripts.push({
      events: [{ kind: 'init', sessionId: 's1' }, { kind: 'entry', uuid: 'e1' }, { kind: 'assistantText', text: 'A1' }, okResult]
    })
    await svc.send(c.id, 'one')
    await stoppedTurn(c.id, running(), 'two')
    expect(await lostOf(c.id)).toEqual(['scan the logs', 'review the diff'])
    const second = (await itemsOf(c.id))[2]
    scripts.push({
      events: [{ kind: 'init', sessionId: 's2' }, { kind: 'entry', uuid: 'f1' }, { kind: 'assistantText', text: 'B2' }, okResult]
    })
    await svc.rerun(c.id, second.id, 'two, edited')
    expect(calls[2].args).toContain('--resume-session-at')
    expect(calls[2].stdin).toBe('two, edited')
    expect(await lostOf(c.id)).toBeUndefined()
  })

  // Stopped, with nothing running: the rewind alone makes the note moot, however the run then ends.
  it('a cut run set up by a version switch adds no note and clears lost', async () => {
    const c = await store.create('helper', dir)
    await store.update(c.id, { sessionId: 's1', next: { at: 'e1' }, lost: ['scan the logs'] })
    await stoppedTurn(c.id, [{ kind: 'init', sessionId: 's2' }])
    expect(calls[0].args).toContain('--resume-session-at')
    expect(calls[0].stdin).toBe('go')
    expect(await lostOf(c.id)).toBeUndefined()
  })

  it('a planned reseed adds no note and clears lost', async () => {
    const c = await store.create('helper', dir)
    await store.update(c.id, { sessionId: null, next: { seed: true }, lost: ['scan the logs'] })
    await stoppedTurn(c.id, [{ kind: 'init', sessionId: 's2' }])
    expect(calls[0].args).not.toContain('--resume')
    expect(calls[0].stdin).not.toContain('results are lost')
    expect(await lostOf(c.id)).toBeUndefined()
  })

  it('a reseed after a missing session: the resume carried the note, the seeded retry does not, and lost is cleared', async () => {
    const c = await store.create('helper', dir)
    await store.update(c.id, { sessionId: 'old', lost: ['scan the logs'] })
    scripts.push({ outcome: { result: null, stderr: 'No conversation found with session ID: old' } }, { events: pong })
    await svc.send(c.id, 'go')
    expect(calls[0].stdin).toBe(`go\n\n${lostNote(['scan the logs'])}`)
    expect(calls[1].args).not.toContain('--resume')
    expect(calls[1].stdin).not.toContain('results are lost')
    expect(await lostOf(c.id)).toBeUndefined()
  })

  it('a compact adds no note and keeps lost for the next turn', async () => {
    const c = await store.create('helper', dir)
    await stoppedTurn(c.id, running())
    await svc.compact(c.id, '')
    expect(calls[1].stdin).toBe('/compact')
    expect(await lostOf(c.id)).toEqual(['scan the logs', 'review the diff'])
    await svc.send(c.id, 'continue')
    expect(calls[2].stdin).toBe(`continue\n\n${NOTE}`)
  })

  it('a compact that is a cut run (after a version switch) adds no note and clears lost, so the turn after it is not told', async () => {
    const c = await store.create('helper', dir)
    await stoppedTurn(c.id, running())
    expect(await lostOf(c.id)).toEqual(['scan the logs', 'review the diff'])
    // A version switch: the next run cuts the session at an entry from before the stopped turn.
    await store.update(c.id, { next: { at: 'e0' } })
    scripts.push({ events: [{ kind: 'init', sessionId: 's2' }, { kind: 'compacted', pre: 5000, post: 900 }, okResult] })
    await svc.compact(c.id, '')
    expect(calls[1].args).toContain('--resume-session-at')
    expect(calls[1].stdin).toBe('/compact')
    expect(await lostOf(c.id)).toBeUndefined()
    expect((await store.get(c.id))?.next).toBeUndefined()
    await svc.send(c.id, 'continue')
    expect(calls[2].args).not.toContain('--resume-session-at')
    expect(calls[2].stdin).toBe('continue')
  })

  it('a failed save is logged by its code only and never fails the turn', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const real = store.patchInPlace.bind(store)
    const writes: string[][] = []
    vi.spyOn(store, 'patchInPlace').mockImplementation(async (id, fn) => {
      const cur = (await store.get(id))!
      const patch = fn(cur)
      if (patch && 'lost' in patch) {
        writes.push(patch.lost ?? [])
        throw Object.assign(new Error('EACCES: permission denied, open /data/chats.json'), { code: 'EACCES' })
      }
      return real(id, fn)
    })
    const c = await store.create('helper', dir)
    await stoppedTurn(c.id, running())
    expect(writes).toEqual([['scan the logs', 'review the diff']])
    expect(shape(await itemsOf(c.id))).toEqual(['user', 'tool', 'tool', 'notice:stopped'])
    expect(await store.get(c.id)).toMatchObject({ inFlight: false })
    // The clear fails too: the next turn still ends as it would.
    await store.update(c.id, { lost: ['scan the logs'] })
    await svc.send(c.id, 'continue')
    expect(shape(await itemsOf(c.id))).toEqual(['user', 'tool', 'tool', 'notice:stopped', 'user', 'assistant'])
    // Cleared once when the run started, and once more when it ended on its own; never on every event.
    expect(writes).toEqual([['scan the logs', 'review the diff'], [], []])
    const logged = log.mock.calls.flat().join(' ')
    expect(logged).toContain('EACCES')
    expect(logged).not.toContain('/data')
    log.mockRestore()
  })

  describe('and Pause', () => {
    const settings = pauseSettings({ node: '/opt/node', entry: '/opt/pauseHook.mjs', electronNode: false })
    const bash = (id: string): RunEvent => ({ kind: 'toolUse', id, name: 'Bash', input: { command: 'ls' } })
    const blocked = (id: string): RunEvent => ({
      kind: 'toolResult',
      toolUseId: id,
      content: `PreToolUse:Bash hook error: [sh]: ${PAUSE_BLOCK_TEXT}`,
      isError: true
    })
    beforeEach(() => {
      svc = makeService({ dispatch, tmp: new ChatTmp(join(dir, 'claude-tmp')), pauseHook: { settings } })
    })
    const pausing = async (chatId: string) => {
      await store.update(chatId, { pause: 'pausing' })
      await svc.setPauseFlag(chatId, true)
    }

    it('a pause that ends with the wrap-up records nothing', async () => {
      const c = await store.create('helper', dir)
      scripts.push({
        act: () => pausing(c.id),
        events: [
          { kind: 'init', sessionId: 's1' },
          agentCall('a1', 'scan the logs'),
          { kind: 'toolResult', toolUseId: 'a1', content: 'scanned', isError: false },
          bash('t1'),
          blocked('t1'),
          { kind: 'assistantText', text: 'Paused after the scan.' },
          okResult
        ]
      })
      await svc.send(c.id, 'go')
      expect(await store.get(c.id)).toMatchObject({ pause: 'paused' })
      expect(await lostOf(c.id)).toBeUndefined()
    })

    it('the safety cap records nothing, even for a call that lands as it stops the run', async () => {
      const c = await store.create('helper', dir)
      await pausing(c.id)
      const { p } = hangingTurn(c.id, [
        { kind: 'init', sessionId: 's1' },
        ...['b1', 'b2', 'b3'].flatMap((id) => [bash(id), blocked(id)]),
        // Sent after the cap stopped the run, before the process is gone: the hook blocks it, so nothing ran.
        agentCall('late', 'scan the logs')
      ])
      await p
      expect((await dispatch.list(c.id)).map((s) => [s.id, s.status])).toEqual([['late', 'interrupted']])
      expect(await store.get(c.id)).toMatchObject({ pause: 'paused' })
      expect(await lostOf(c.id)).toBeUndefined()
    })

    it('a Stop while pausing still records what it killed', async () => {
      const c = await store.create('helper', dir)
      await pausing(c.id)
      await stoppedTurn(c.id, running())
      expect(await store.get(c.id)).toMatchObject({ pause: 'paused' })
      expect(await lostOf(c.id)).toEqual(['scan the logs', 'review the diff'])
    })
  })
})

describe('codex engine', () => {
  const DEF = { body: 'You are the Codex helper.', model: 'gpt-6-sol' }
  const mcpOf = (name: string): McpServerSpec => ({ name, command: '/n', args: ['/b.mjs'], passEnv: [], fixedEnv: {} })
  const prior: ChatItem[] = [
    { type: 'user', id: 'u0', text: 'hello', ts: 1 },
    { type: 'assistant', id: 'a0', text: 'hi', ts: 2 }
  ]
  const kinds = (items: ChatItem[]) => items.map((i) => (i.type === 'notice' ? `notice:${i.kind}` : i.type))
  const lastError = async (id: string) => (await itemsOf(id)).filter((i) => i.type === 'error').pop()
  let codexCalls: CodexRunOptions[]
  let codexBin: string | null
  let codexAgents: Set<string>
  let defs: string[]
  // What a run started from, and the prompt of its turn.
  const threadOf = (o: CodexRunOptions) => (o.start.kind === 'new' ? null : o.start.threadId)
  const promptOf = (o: CodexRunOptions) => (o.action.kind === 'turn' ? o.action.prompt : null)
  // The Claude fake's script player, for codex.run: the same `scripts`, `sent` and stop. Like runCodex it puts the run's
  // requestTag on the ids it emits, and takes only tagged ids back, without the tag, so `sent` holds Codex's own ids.
  const codexRun = (o: CodexRunOptions): RunHandle => {
    codexCalls.push(o)
    emit = o.onEvent
    const s = scripts.shift() ?? { events: pong }
    const prefix = o.requestTag === undefined ? '' : `${o.requestTag}:`
    const tag = (e: RunEvent): RunEvent =>
      e.kind === 'permissionRequest' || e.kind === 'permissionCancel' || (e.kind === 'controlUnknown' && e.requestId !== null)
        ? ({ ...e, requestId: prefix + e.requestId } as RunEvent)
        : e
    let release: (x: RunOutcome) => void = () => {}
    const done = new Promise<RunOutcome>((resolve) => {
      release = resolve
      const fire = () => s.events?.forEach((e) => o.onEvent(tag(e)))
      if (s.hang) {
        s.end = () => resolve(baseOutcome(s.outcome))
        setImmediate(() => {
          fire()
          s.ready?.()
        })
      } else
        setImmediate(() => {
          fire()
          resolve(baseOutcome(s.outcome))
        })
    })
    return {
      stop: () => release(baseOutcome({ exitCode: null, signal: 'SIGINT', result: null, stopped: true })),
      send: (m: object) => {
        const r = (m as { response?: { request_id?: unknown } }).response
        if (typeof r?.request_id !== 'string' || !r.request_id.startsWith(prefix)) return false
        if (sendOk) sent.push({ ...m, response: { ...r, request_id: r.request_id.slice(prefix.length) } })
        return sendOk
      },
      done
    }
  }
  const withCodex = (extra: Partial<ChatServiceDeps> = {}) =>
    makeService({
      engineOf: async (agent) => (codexAgents.has(agent) ? 'codex' : 'claude'),
      codex: {
        locate: async () => codexBin,
        run: codexRun,
        definitionOf: async (agent) => {
          defs.push(agent)
          return codexAgents.has(agent) ? { ...DEF } : null
        }
      },
      ...extra
    })
  const allBridges = (): Partial<ChatServiceDeps> => ({
    browserTurns: {
      profileId: async () => 'p',
      create: async () => ({
        mcp: mcpOf('zumibot_browser'),
        args: ['--mcp-config', 'browser-config'],
        env: { ZUMIBOT_BROWSER_CAPABILITY: 'browser-cap' },
        prompt: 'Browser prompt',
        dispose: async () => {}
      })
    },
    todoTurns: {
      create: () => ({
        mcp: mcpOf('zumibot_todos'),
        args: ['--mcp-config', 'todo-config'],
        env: { ZUMIBOT_TODOS_CAPABILITY: 'todo-cap' },
        dispose: () => {}
      })
    },
    vaultTurns: {
      create: () => ({
        mcp: mcpOf('zumibot_vault'),
        args: ['--mcp-config', 'vault-config'],
        env: { ZUMIBOT_VAULT_CAPABILITY: 'vault-cap' },
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

  beforeEach(() => {
    codexCalls = []
    codexBin = '/bin/codex'
    codexAgents = new Set(['cx'])
    defs = []
    svc = withCodex()
  })

  it('a Codex send runs codex, never claude, on the agent body, its model and the to-do paragraph', async () => {
    const ends: TurnEnd[] = []
    svc = withCodex({ todoTurns: allBridges().todoTurns, onTurnEnd: (e) => ends.push(e) })
    const c = await store.create('cx', dir)
    await svc.send(c.id, 'hello')
    expect(calls).toHaveLength(0)
    expect(codexCalls).toHaveLength(1)
    const o = codexCalls[0]
    expect(o).toMatchObject({ bin: '/bin/codex', cwd: dir, start: { kind: 'new' }, action: { kind: 'turn', prompt: 'hello' } })
    expect(o.thread).toMatchObject({ cwd: dir, model: DEF.model, permissionMode: 'auto' })
    expect(o.thread.baseInstructions.startsWith(DEF.body)).toBe(true)
    expect(o.thread.baseInstructions).toBe([DEF.body, TODO_SYSTEM].join('\n\n'))
    expect(defs).toEqual(['cx'])
    expect(kinds(await itemsOf(c.id))).toEqual(['user', 'assistant'])
    expect(await store.get(c.id)).toMatchObject({ sessionId: 's1', sessionEngine: 'codex', inFlight: false })
    expect(ends).toEqual([{ chatId: c.id, agent: 'cx', outcome: 'ok', reply: expect.any(String) }])
  })

  it("a Codex agent's run gets none of the agent run config, nor does its Compact or side base", async () => {
    const agentRunConfig = vi.fn(async () => ({
      disallowedTools: ['mcp__x'],
      extraArgs: ['--mcp-config', '{"mcpServers":{"own":{"command":"x"}}}'],
      env: { ZUMIBOT_MCP_VAULT_0: 'v' },
      dropped: [],
      connectorPrefixes: {},
      connectorsOff: []
    }))
    svc = withCodex({ ...allBridges(), agentRunConfig })
    const c = await store.create('cx', dir)
    await svc.send(c.id, 'hello')
    await svc.compact(c.id, '')
    expect(calls).toHaveLength(0)
    expect(codexCalls).toHaveLength(2)
    expect(agentRunConfig).not.toHaveBeenCalled()
    for (const o of codexCalls) {
      expect(o.env?.ZUMIBOT_MCP_VAULT_0).toBeUndefined()
      expect(o.thread.mcpServers.map((s) => s.name)).not.toContain('own')
    }
    const b = svc.sideBase(c.id, 'cx')!
    expect(b.codex).toBeDefined()
    expect('env' in b).toBe(false)
    expect(b.args).toMatchObject({ disallowedTools: [], extraArgs: [] })
  })

  it('the next send resumes the thread, and the definition is read on every attempt', async () => {
    const c = await store.create('cx', dir)
    await svc.send(c.id, 'one')
    await svc.send(c.id, 'two')
    expect(codexCalls.map(threadOf)).toEqual([null, 's1'])
    expect(codexCalls[1].start).toEqual({ kind: 'resume', threadId: 's1' })
    expect(defs).toEqual(['cx', 'cx'])
    expect(kinds(await itemsOf(c.id))).toEqual(['user', 'assistant', 'user', 'assistant'])
  })

  it('every bridge reaches Codex as an MCP server, and what Codex skips never reaches its run', async () => {
    const KEY = 'tok-secret-ABCD1234'
    const plan = vi.fn(async (): Promise<DesktopPlan> => ({ profileId: 'p' }))
    const begin = vi.fn(async () => ({ dir: join(dir, 'mem'), note: 'MEMORY NOTE' }))
    const end = vi.fn()
    const compactWindow = vi.fn(async () => 400000)
    const costBaseline = vi.fn(async () => null)
    svc = withCodex({
      ...allBridges(),
      desktopTurns: {
        plan,
        create: async () => {
          throw new Error('no desktop for Codex')
        }
      },
      memory: { begin, end },
      tmp: new ChatTmp(join(dir, 'claude-tmp')),
      pauseHook: { settings: '{"hooks":{}}' },
      vaultGuard: '{"permissions":{}}',
      compactWindow,
      costBaseline,
      vaultEnv: () => ({ env: { AZURE_DEVOPS_EXT_PAT: KEY }, scrub: new Map([[KEY, '[vault: Azure PAT]']]) })
    })
    const c = await store.create('cx', dir)
    // A window an earlier turn reported, past the agent's limit, so the limit is sent.
    await store.update(c.id, { sessionId: 'th-1', sessionEngine: 'codex', context: { used: 1000, window: 1_000_000 } })
    await svc.send(c.id, 'hello')
    expect(calls).toHaveLength(0)
    const o = codexCalls[0]
    expect(threadOf(o)).toBe('th-1')
    expect(o.thread.mcpServers.map((s) => s.name)).toEqual(['zumibot_browser', 'zumibot_todos', 'zumibot_vault', 'zumibot_agents'])
    expect(o.thread.baseInstructions).toBe(
      [DEF.body, TODO_SYSTEM, VAULT_SYSTEM, askSystem([{ name: 'b', description: 'Makes cards' }]), 'Browser prompt'].join('\n\n')
    )
    expect(o.env).toMatchObject({
      ZUMIBOT_BROWSER_CAPABILITY: 'browser-cap',
      ZUMIBOT_TODOS_CAPABILITY: 'todo-cap',
      ZUMIBOT_VAULT_CAPABILITY: 'vault-cap',
      ZUMIBOT_ASKS_CAPABILITY: 'ask-cap'
    })
    expect(
      Object.keys(o.env ?? {}).filter(
        (k) => k.startsWith('ZUMIBOT_PAUSE') || k.startsWith('CLAUDE_CODE_AUTO_COMPACT') || k === 'CLAUDE_CODE_TMPDIR'
      )
    ).toEqual([])
    expect(JSON.stringify(o)).not.toContain(KEY)
    expect(plan).not.toHaveBeenCalled()
    expect(begin).not.toHaveBeenCalled()
    expect(end).not.toHaveBeenCalled()
    // Read for Codex too, but as a thread config value: the env var asserted absent above is the Claude CLI's.
    expect(o.thread.autoCompactTokenLimit).toBe(400000)
    expect(costBaseline).not.toHaveBeenCalled()
    // Its side base: the thread's instructions less the browser prompt (the side turn brings its own), no Claude parts and no
    // point outside `codex`, so no Claude fork can read a Codex thread id. No earlier turn: nothing completed to fork yet.
    const b = svc.sideBase(c.id, 'cx')!
    expect(b).toMatchObject({
      bin: '/bin/codex',
      cwd: dir,
      tmpDir: null,
      browser: true,
      asks: true,
      active: false,
      live: null,
      start: null,
      scrub: new Map([[KEY, '[vault: Azure PAT]']])
    })
    expect(b.desktop).toBeUndefined()
    expect(b.codex).toEqual({
      threadId: '',
      at: null,
      baseInstructions: [DEF.body, TODO_SYSTEM, VAULT_SYSTEM, askSystem([{ name: 'b', description: 'Makes cards' }])].join('\n\n'),
      model: DEF.model
    })
    expect([b.codex!.baseInstructions, 'Browser prompt'].join('\n\n')).toBe(o.thread.baseInstructions)
    // The side turn keeps each bridge's own spec, in the main run's order, for the Codex side run to configure.
    const side = (await svc.sideBrowser(c.id, 'cx', undefined, b.asks))!
    expect(side.servers?.map((s) => s.name)).toEqual(o.thread.mcpServers.map((s) => s.name))
    await side.dispose()
  })

  it('a turn with no server of its own, or a name the Codex config cannot key, gives Codex no server for it', async () => {
    svc = withCodex({
      browserTurns: { profileId: async () => null, create: vi.fn() },
      todoTurns: { create: () => ({ mcp: mcpOf('zumibot.todos'), args: [], env: {}, dispose: () => {} }) },
      vaultTurns: { create: () => ({ mcp: { ...mcpOf('zumibot_vault'), command: '' }, args: [], env: {}, dispose: () => {} }) }
    })
    const c = await store.create('cx', dir)
    await svc.send(c.id, 'hello')
    expect(codexCalls[0].thread.mcpServers).toEqual([])
    expect(codexCalls[0].thread.baseInstructions).toContain('The agent browser is unavailable.')
  })

  it('a command model never reaches Codex or the chat, and a model an earlier Claude command left is ignored', async () => {
    svc = withCodex({ agentModel: async () => 'sonnet' })
    const fix = { agent: 'cx', name: 'fix', prompt: 'Fix it', model: 'opus' as const }
    const c = await store.create('cx', dir)
    await svc.send(c.id, '/fix x', [], undefined, undefined, fix)
    expect(codexCalls[0].thread.model).toBe(DEF.model)
    expect((await store.get(c.id))?.model).toBeUndefined()
    const old = await store.create('cx', dir)
    await store.update(old.id, { model: 'haiku' })
    await svc.send(old.id, 'hello')
    expect(codexCalls[1].thread.model).toBe(DEF.model)
  })

  it('a Codex model picked by hand runs the turn, the side base and Compact', async () => {
    const c = await store.create('cx', dir)
    await svc.setModel(c.id, 'gpt-6-mini')
    expect(await store.get(c.id)).toMatchObject({ model: 'gpt-6-mini', modelByHand: true })
    await svc.send(c.id, 'hello')
    expect(codexCalls[0].thread.model).toBe('gpt-6-mini')
    expect(svc.sideBase(c.id, 'cx')?.codex?.model).toBe('gpt-6-mini')
    await store.update(c.id, { sessionId: 'th-1', sessionEngine: 'codex' })
    scripts.push({ events: [{ kind: 'init', sessionId: 'th-1' }, { kind: 'compacted', pre: 90_000, post: 4_000 }, okResult] })
    await svc.compact(c.id, '')
    expect(codexCalls[1]).toMatchObject({ action: { kind: 'compact' }, thread: { model: 'gpt-6-mini' } })
    // Default puts it back on the agent file's model.
    await svc.setModel(c.id, null)
    await svc.send(c.id, 'again')
    expect(codexCalls[2].thread.model).toBe(DEF.model)
  })

  it("setModel refuses a model the chat's engine cannot run, and stores nothing", async () => {
    const cx = await store.create('cx', dir)
    await expect(svc.setModel(cx.id, 'sonnet')).rejects.toThrow("That model is not one this chat's agent can run")
    const claude = await store.create('helper', dir)
    await expect(svc.setModel(claude.id, 'gpt-6-mini')).rejects.toThrow("That model is not one this chat's agent can run")
    expect((await store.get(cx.id))?.model).toBeUndefined()
    expect((await store.get(claude.id))?.model).toBeUndefined()
  })

  it('a Codex chat in Ask runs its thread on the manual policy; Plan, Accept edits and effort are refused there', async () => {
    const c = await store.create('cx', dir)
    await svc.setPermissionMode(c.id, 'manual')
    await svc.send(c.id, 'hello')
    expect(codexCalls[0].thread.permissionMode).toBe('manual')
    await expect(svc.setPermissionMode(c.id, 'plan')).rejects.toThrow("That mode is not one this chat's agent can run")
    await expect(svc.setPermissionMode(c.id, 'acceptEdits')).rejects.toThrow("That mode is not one this chat's agent can run")
    await expect(svc.setEffort(c.id, 'high')).rejects.toThrow("This chat's agent has no effort setting")
    expect(await store.get(c.id)).toMatchObject({ permissionMode: 'manual' })
    expect((await store.get(c.id))?.effort).toBeUndefined()
  })

  it('a Plan mode or effort left from when the agent ran on Claude never reaches Codex', async () => {
    const c = await store.create('cx', dir)
    await store.update(c.id, { permissionMode: 'plan', effort: 'max' })
    await svc.send(c.id, 'hello')
    expect(codexCalls[0].thread.permissionMode).toBe('auto')
  })

  it('a Codex pick left from when the agent ran on Codex never reaches claude, and a command replaces it', async () => {
    const c = await store.create('helper', dir)
    await store.update(c.id, { model: 'gpt-6-mini', modelByHand: true })
    await svc.send(c.id, 'hello')
    expect(calls[0].args).not.toContain('--model')
    const card = { agent: 'helper', name: 'card', prompt: 'Make a card', model: 'sonnet' as const }
    await store.update(c.id, { sessionId: null })
    await svc.send(c.id, '/card x', [], undefined, undefined, card)
    expect(calls[1].args).toContain('sonnet')
    // Set by the command, not by hand: a later command may still move it.
    expect(await store.get(c.id)).toMatchObject({ model: 'sonnet' })
    expect((await store.get(c.id))?.modelByHand).toBeUndefined()
  })

  it("a model of 'inherit' (any case) or blank in a Codex agent file sends no model, so Codex uses its own default", async () => {
    let model: string | null = 'inherit'
    svc = withCodex({ codex: { locate: async () => codexBin, run: codexRun, definitionOf: async () => ({ ...DEF, model }) } })
    const c = await store.create('cx', dir)
    for (const m of ['inherit', 'Inherit', '  ', '', null]) {
      model = m
      await svc.send(c.id, 'hello')
      expect(codexCalls.at(-1)!.thread.model).toBeUndefined()
    }
    model = ' gpt-6-sol '
    await svc.send(c.id, 'hello')
    expect(codexCalls.at(-1)!.thread.model).toBe('gpt-6-sol')
  })

  it('a Claude session never reaches Codex: the turn starts a fresh thread from the history', async () => {
    const c = await store.create('cx', dir)
    await store.update(c.id, { sessionId: 'claude-s' })
    await store.saveItems(c.id, prior)
    await svc.send(c.id, 'ping')
    expect(codexCalls).toHaveLength(1)
    expect(threadOf(codexCalls[0])).toBeNull()
    expect(promptOf(codexCalls[0])).toBe(buildSeedPrompt(prior, 'ping'))
    expect(kinds(await itemsOf(c.id))).toEqual(['user', 'assistant', 'user', 'notice:expired', 'assistant'])
    expect(await store.get(c.id)).toMatchObject({ sessionId: 's1', sessionEngine: 'codex' })
  })

  it('a Codex thread never reaches claude --resume, and the Claude session that replaces it clears the mark', async () => {
    const c = await store.create('helper', dir)
    await store.update(c.id, { sessionId: 'th-1', sessionEngine: 'codex' })
    await store.saveItems(c.id, prior)
    await svc.send(c.id, 'ping')
    expect(codexCalls).toHaveLength(0)
    expect(calls[0].args).not.toContain('--resume')
    expect(calls[0].args).not.toContain('th-1')
    expect(calls[0].stdin).toBe(buildSeedPrompt(prior, 'ping'))
    expect(kinds(await itemsOf(c.id))).toEqual(['user', 'assistant', 'user', 'notice:expired', 'assistant'])
    const meta = await store.get(c.id)
    expect(meta?.sessionId).toBe('s1')
    expect(meta?.sessionEngine).toBeUndefined()
    await svc.send(c.id, 'again')
    expect(calls[1].args).toContain('--resume')
  })

  // A Codex turn as the runner emits it: the thread, the reply, then the turn's id before the result.
  const cxTurn = (thread: string, text: string, turn: string): Script => ({
    events: [{ kind: 'init', sessionId: thread }, { kind: 'assistantText', text }, { kind: 'entry', uuid: turn }, okResult]
  })

  it('a rewind point on a Codex chat forks the thread at that turn, no reseed', async () => {
    const c = await store.create('cx', dir)
    await store.update(c.id, { sessionId: 'th-1', sessionEngine: 'codex', next: { at: 'turn-1' } })
    await store.saveItems(c.id, prior)
    scripts.push(cxTurn('th-2', 'pong', 'turn-2'))
    await svc.send(c.id, 'ping')
    expect(codexCalls[0].start).toEqual({ kind: 'fork', threadId: 'th-1', lastTurnId: 'turn-1' })
    expect(promptOf(codexCalls[0])).toBe('ping')
    expect(kinds(await itemsOf(c.id))).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(await store.get(c.id)).toMatchObject({ sessionId: 'th-2', sessionEngine: 'codex' })
  })

  it('a fork codex refuses with any error reseeds once against the fake: a thread/start with the history, and the point is gone', async () => {
    const fake = fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url))
    const bin = writeFakeBin(dir, 'codex-shim', fake)
    const home = join(dir, 'codex-home'),
      log = join(dir, 'codex-log.jsonl')
    mkdirSync(join(home, 'threads'), { recursive: true })
    writeFileSync(join(home, 'threads', 'th-src'), '') // the source thread exists: only the fork itself fails
    const fakeEnv = { FAKE_CODEX_HOME: home, FAKE_CODEX_LOG: log, FAKE_CODEX_FORK_ERROR: 'fork exploded' }
    codexBin = bin
    svc = withCodex({
      codex: {
        locate: async () => bin,
        run: (o) => runCodex({ ...o, env: { ...process.env, ...o.env, ...fakeEnv } }),
        definitionOf: async () => ({ ...DEF })
      }
    })
    const c = await store.create('cx', dir)
    await store.update(c.id, { sessionId: 'th-src', sessionEngine: 'codex', next: { at: 'turn-1' } })
    await store.saveItems(c.id, prior)
    await svc.send(c.id, 'ping')
    const sent = () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { method: string; params: any })
    expect(sent().map((l) => l.method)).toEqual(['initialize', 'thread/fork', 'initialize', 'thread/start', 'turn/start'])
    expect(sent()[1].params).toMatchObject({ threadId: 'th-src', lastTurnId: 'turn-1' })
    expect(sent()[4].params.input).toEqual(codexInput(buildSeedPrompt(prior, 'ping')))
    expect(kinds(await itemsOf(c.id))).toEqual(['user', 'assistant', 'user', 'notice:expired'])
    const meta = (await store.get(c.id))!
    expect(meta).toMatchObject({ sessionEngine: 'codex', inFlight: false })
    expect(meta.sessionId).toBe(sent()[4].params.threadId)
    expect(meta.next).toBeUndefined()
    // The next send resumes the new thread: the failing fork is never tried again.
    await svc.send(c.id, 'again')
    expect(
      sent()
        .slice(5)
        .map((l) => l.method)
    ).toEqual(['initialize', 'thread/resume', 'turn/start'])
    expect(sent()[6].params.threadId).toBe(meta.sessionId)
  }, 20_000)

  it('a Codex reply never carries a cut stamp, even after an entry: only the turn end points into its thread', async () => {
    scripts.push({
      events: [
        { kind: 'init', sessionId: 'th-1' },
        { kind: 'entry', uuid: 'turn-0' },
        { kind: 'assistantText', text: 'hi' },
        { kind: 'entry', uuid: 'turn-1' },
        okResult
      ]
    })
    const c = await store.create('cx', dir)
    await svc.send(c.id, 'hello')
    const reply = (await itemsOf(c.id)).find((i) => i.type === 'assistant')
    expect(reply).not.toHaveProperty('cut')
    expect(reply?.end).toEqual({ session: 'th-1', at: 'turn-1', engine: 'codex' })
  })

  it("a Codex turn's last item gets an end stamp with the thread, the turn id and the engine", async () => {
    scripts.push({
      events: [{ kind: 'init', sessionId: 'th-1' }, { kind: 'assistantText', text: 'hi' }, { kind: 'entry', uuid: 'turn-1' }, okResult]
    })
    const c = await store.create('cx', dir)
    await svc.send(c.id, 'hello')
    const items = await itemsOf(c.id)
    expect(items.at(-1)?.end).toEqual({ session: 'th-1', at: 'turn-1', engine: 'codex' })
  })

  it('an edit forks the Codex thread at the turn before it and keeps the engine mark', async () => {
    scripts.push(cxTurn('th-1', 'a1', 'turn-1'), cxTurn('th-1', 'a2', 'turn-2'), cxTurn('th-2', 'a3', 'turn-3'))
    const c = await store.create('cx', dir)
    await svc.send(c.id, 'one')
    await svc.send(c.id, 'two')
    const items = await itemsOf(c.id)
    await svc.rerun(c.id, items[2].id, 'two, edited')
    expect(codexCalls.map((o) => o.start.kind)).toEqual(['new', 'resume', 'fork'])
    expect(codexCalls[2].start).toEqual({ kind: 'fork', threadId: 'th-1', lastTurnId: 'turn-1' })
    expect(promptOf(codexCalls[2])).toBe('two, edited')
    expect(kinds(await itemsOf(c.id))).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(await store.get(c.id)).toMatchObject({ sessionId: 'th-2', sessionEngine: 'codex', inFlight: false })
  })

  it("a fork answer with the thread it came from stops the run with Codex's fork-ignored sentence and reseeds nothing", async () => {
    const leak = cxTurn('th-1', 'leak', 'turn-3')
    leak.events![0] = { kind: 'init', sessionId: 'th-1', version: '0.164.0' }
    scripts.push(cxTurn('th-1', 'a1', 'turn-1'), cxTurn('th-1', 'a2', 'turn-2'), leak)
    const c = await store.create('cx', dir)
    await svc.send(c.id, 'one')
    await svc.send(c.id, 'two')
    const items = await itemsOf(c.id)
    await svc.rerun(c.id, items[2].id, 'two, edited')
    expect(codexCalls).toHaveLength(3)
    const after = await itemsOf(c.id)
    // Codex and its version, never Claude Code's --fork-session.
    expect(after.at(-1)).toMatchObject({ type: 'error', text: CODEX_REFUSALS.forkIgnored('0.164.0') })
    expect(after.some((i) => i.type === 'assistant' && i.text === 'leak')).toBe(false)
    expect(after.some((i) => i.type === 'notice')).toBe(false)
    // The source thread stays the chat's, and the cut stays for a retry.
    expect(await store.get(c.id)).toMatchObject({ sessionId: 'th-1', next: { at: 'turn-1' }, inFlight: false })
  })

  it('a fork of a missing thread reseeds once with the expired notice', async () => {
    scripts.push(
      cxTurn('th-1', 'a1', 'turn-1'),
      cxTurn('th-1', 'a2', 'turn-2'),
      { outcome: { result: null, missingSession: true } },
      cxTurn('th-new', 'a3', 'turn-3')
    )
    const c = await store.create('cx', dir)
    await svc.send(c.id, 'one')
    await svc.send(c.id, 'two')
    const items = await itemsOf(c.id)
    await svc.rerun(c.id, items[2].id, 'two, edited')
    expect(codexCalls.map((o) => o.start.kind)).toEqual(['new', 'resume', 'fork', 'new'])
    expect(promptOf(codexCalls[3])).toBe(buildSeedPrompt(items.slice(0, 2), 'two, edited'))
    expect(kinds(await itemsOf(c.id))).toEqual(['user', 'assistant', 'user', 'notice:expired', 'assistant'])
    expect(await store.get(c.id)).toMatchObject({ sessionId: 'th-new', sessionEngine: 'codex' })
  })

  it("switching back to an earlier version forks the Codex thread at that version's last turn", async () => {
    scripts.push(
      cxTurn('th-1', 'a1', 'turn-1'),
      cxTurn('th-1', 'a2', 'turn-2'),
      cxTurn('th-2', 'b2', 'turn-3'),
      cxTurn('th-3', 'c', 'turn-4')
    )
    const c = await store.create('cx', dir)
    await svc.send(c.id, 'one')
    await svc.send(c.id, 'two')
    const first = await itemsOf(c.id)
    await svc.rerun(c.id, first[2].id, 'two, edited')
    const edited = (await itemsOf(c.id))[2]
    await svc.switchVersion(c.id, edited.id, 0)
    expect(await store.get(c.id)).toMatchObject({ sessionId: 'th-1', sessionEngine: 'codex', next: { at: 'turn-2' } })
    await svc.send(c.id, 'three')
    expect(codexCalls[3].start).toEqual({ kind: 'fork', threadId: 'th-1', lastTurnId: 'turn-2' })
  })

  it('codex not found adds the fixed sentence and runs nothing', async () => {
    codexBin = null
    const c = await store.create('cx', dir)
    await svc.send(c.id, 'ping')
    expect(calls).toHaveLength(0)
    expect(codexCalls).toHaveLength(0)
    expect(await lastError(c.id)).toMatchObject({ text: CODEX_REFUSALS.notFound })
    // A server without the Codex deps refuses the same way.
    svc = makeService({ engineOf: async () => 'codex' })
    await svc.send(c.id, 'again')
    expect(calls).toHaveLength(0)
    expect((await itemsOf(c.id)).filter((i) => i.type === 'error').map((i) => i.type === 'error' && i.text)).toEqual([
      CODEX_REFUSALS.notFound,
      CODEX_REFUSALS.notFound
    ])
  })

  it('a missing thread reseeds once', async () => {
    const c = await store.create('cx', dir)
    await store.update(c.id, { sessionId: 'th-old', sessionEngine: 'codex' })
    await store.saveItems(c.id, prior)
    scripts.push(
      { outcome: { result: null, missingSession: true } },
      { events: [{ kind: 'init', sessionId: 'th-new' }, { kind: 'assistantText', text: 'pong' }, okResult] }
    )
    await svc.send(c.id, 'ping')
    expect(codexCalls.map(threadOf)).toEqual(['th-old', null])
    expect(promptOf(codexCalls[1])).toBe(buildSeedPrompt(prior, 'ping'))
    expect(kinds(await itemsOf(c.id))).toEqual(['user', 'assistant', 'user', 'notice:expired', 'assistant'])
    expect(await store.get(c.id)).toMatchObject({ sessionId: 'th-new', sessionEngine: 'codex' })
  })

  it("a failed run shows codex's error with the run's private values redacted, never Claude's missing-session rule", async () => {
    svc = withCodex({
      todoTurns: {
        create: () => ({ mcp: mcpOf('zumibot_todos'), args: [], env: { ZUMIBOT_TODOS_CAPABILITY: 'todo-cap-xyz' }, dispose: () => {} })
      }
    })
    const c = await store.create('cx', dir)
    await store.update(c.id, { sessionId: 'th-1', sessionEngine: 'codex' })
    scripts.push({ outcome: { result: null, exitCode: 1, stderr: 'No conversation found with session ID: th-1 todo-cap-xyz' } })
    await svc.send(c.id, 'ping')
    expect(codexCalls).toHaveLength(1)
    expect(await lastError(c.id)).toMatchObject({ text: 'No conversation found with session ID: th-1 [private browser value]' })
    scripts.push({ outcome: { result: null, exitCode: 2, stderr: '' } })
    await svc.send(c.id, 'again')
    expect(await lastError(c.id)).toMatchObject({ text: 'Codex exited with code 2' })
    scripts.push({ outcome: { result: null, exitCode: 1, stderr: CODEX_REFUSALS.signedOut } })
    await svc.send(c.id, 'once more')
    expect(await lastError(c.id)).toMatchObject({ text: CODEX_REFUSALS.signedOut })
  })

  it('a permission request gets the same card, and its answer goes back through the handle', async () => {
    const c = await store.create('cx', dir)
    const input = { command: 'touch x', cwd: dir }
    let ready!: () => void
    const emitted = new Promise<void>((resolve) => {
      ready = resolve
    })
    scripts.push({
      hang: true,
      ready,
      events: [
        { kind: 'init', sessionId: 's1' },
        { kind: 'toolUse', id: 'i1', name: 'Bash', input },
        { kind: 'permissionRequest', requestId: '0', toolName: 'Bash', input, description: null, reason: null, toolUseId: 'i1' }
      ]
    })
    const p = svc.send(c.id, 'go')
    await emitted
    expect(codexCalls).toHaveLength(1)
    expect(svc.pendingCount(c.id)).toBe(1)
    await vi.waitFor(async () =>
      expect((await itemsOf(c.id)).find((i) => i.type === 'approval')).toMatchObject({ status: 'pending', toolUseId: 'i1' })
    )
    const card = (await itemsOf(c.id)).find((i) => i.type === 'approval')!
    svc.answer(c.id, card.id, 'allow-once')
    // Codex's own id goes back: the card's id only tells this attempt's requests apart from other attempts'.
    expect(sent).toEqual([allowResponse('0', input)])
    expect(svc.pendingCount(c.id)).toBe(0)
    svc.stop(c.id)
    await p
    expect((await itemsOf(c.id)).find((i) => i.type === 'approval')).toMatchObject({ status: 'allowed-once' })
  })

  it('a Codex turn never reads the connector map: its connector-named request is an ordinary card', async () => {
    const agentRunConfig = vi.fn(async () => ({ ...NO_RUN_CONFIG, connectorPrefixes: connectorPrefixes([]) }))
    svc = withCodex({ agentRunConfig, connectorRemembers: () => true })
    const c = await store.create('cx', dir)
    const input = { to: 'a@b.c' }
    const name = 'mcp__claude_ai_Gmail__send_message'
    let ready!: () => void
    const emitted = new Promise<void>((resolve) => {
      ready = resolve
    })
    scripts.push({
      hang: true,
      ready,
      events: [
        { kind: 'init', sessionId: 's1' },
        { kind: 'permissionRequest', requestId: '0', toolName: name, input, description: null, reason: null, toolUseId: null }
      ]
    })
    const p = svc.send(c.id, 'go')
    await emitted
    await vi.waitFor(async () => expect((await itemsOf(c.id)).find((i) => i.type === 'approval')).toMatchObject({ status: 'pending' }))
    const card = (await itemsOf(c.id)).find((i) => i.type === 'approval')!
    expect(card).not.toHaveProperty('connector')
    svc.answer(c.id, card.id, 'allow-agent')
    expect(rules.added).toEqual([['cx', ruleOf(name, input)]])
    expect(agentRunConfig).not.toHaveBeenCalled()
    svc.stop(c.id)
    await p
    expect((await itemsOf(c.id)).find((i) => i.type === 'approval')).toMatchObject({ status: 'allowed-agent' })
  })

  describe('question cards', () => {
    // As codexEvents maps requestUserInput: AskUserQuestion with each question carrying Codex's own id.
    const qInput = {
      questions: [
        { question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: '' }], multiSelect: false, codexId: 'color' }
      ]
    }
    const qReq = (requestId: string): RunEvent => ({
      kind: 'permissionRequest',
      requestId,
      toolName: 'AskUserQuestion',
      input: qInput,
      description: null,
      reason: null,
      toolUseId: null
    })
    const holdQuestion = async (chatId: string) => {
      let ready!: () => void
      const emitted = new Promise<void>((resolve) => {
        ready = resolve
      })
      scripts.push({ hang: true, ready, events: [{ kind: 'init', sessionId: 's1' }, qReq('0')] })
      const p = svc.send(chatId, 'go')
      await emitted
      await vi.waitFor(async () => expect((await itemsOf(chatId)).find((i) => i.type === 'approval')).toBeTruthy())
      return { p, card: (await itemsOf(chatId)).find((i) => i.type === 'approval')! }
    }

    it("shows a card, and the user's answers go back to Codex by its own id", async () => {
      const c = await store.create('cx', dir)
      const { p, card } = await holdQuestion(c.id)
      expect(card).toMatchObject({ toolName: 'AskUserQuestion', status: 'pending' })
      expect(svc.pendingCount(c.id)).toBe(1)
      expect(sent).toEqual([])
      svc.answerQuestions(c.id, card.id, { 'Which color?': 'Red' })
      expect(sent).toEqual([allowResponse('0', { ...qInput, answers: { 'Which color?': 'Red' } })])
      expect(svc.pendingCount(c.id)).toBe(0)
      svc.stop(c.id)
      await p
      expect((await itemsOf(c.id)).find((i) => i.type === 'approval')).toMatchObject({
        status: 'answered',
        answers: { 'Which color?': 'Red' }
      })
    })

    it('Skip denies the card, and the turn goes on', async () => {
      const c = await store.create('cx', dir)
      const { p, card } = await holdQuestion(c.id)
      svc.answer(c.id, card.id, 'deny')
      expect(sent).toEqual([denyResponse('0', SKIPPED_BY_USER)])
      svc.stop(c.id)
      await p
      expect((await itemsOf(c.id)).find((i) => i.type === 'approval')).toMatchObject({ status: 'skipped' })
    })

    it("in an asked turn a Codex agent's question is denied with no card, since nobody reads that chat live", async () => {
      const a = await store.create('helper', dir)
      const b0 = await store.create('cx', dir)
      const b = await store.update(b0.id, {
        asked: { by: 'helper', from: a.id, fromTitle: 'Issue chat', chain: [] },
        title: '@helper · Issue chat'
      })
      scripts.push({
        events: [{ kind: 'init', sessionId: 'sb' }, qReq('0'), { kind: 'assistantText', text: 'Which color should it be?' }, okResult]
      })
      const out = await svc.runAsked(b.id, {
        from: 'helper',
        message: 'make a card',
        chain: ['helper'],
        parent: a.id,
        signal: new AbortController().signal
      })
      expect(out).toEqual({ kind: 'ok', reply: 'Which color should it be?' })
      expect(sent).toEqual([denyResponse('0', QUESTIONS_DENIED('helper'))])
      expect((await itemsOf(b.id)).some((i) => i.type === 'approval')).toBe(false)
    })
  })

  it("every attempt's request ids are its own, though Codex numbers each process's requests from 0", async () => {
    const c = await store.create('cx', dir)
    const input = { command: 'ls', cwd: dir }
    const turn = async (cancel: boolean) => {
      let ready!: () => void
      const emitted = new Promise<void>((resolve) => {
        ready = resolve
      })
      const events: RunEvent[] = [
        { kind: 'init', sessionId: 's1' },
        { kind: 'permissionRequest', requestId: '0', toolName: 'Bash', input, description: null, reason: null, toolUseId: null },
        ...(cancel ? [{ kind: 'permissionCancel', requestId: '0' } as RunEvent] : [])
      ]
      const s: Script = { hang: true, ready, events }
      scripts.push(s)
      const p = svc.send(c.id, 'go')
      await emitted
      return { p, s }
    }
    const cardsOf = async (count: number) => {
      await vi.waitFor(async () => expect((await itemsOf(c.id)).filter((i) => i.type === 'approval')).toHaveLength(count))
      return (await itemsOf(c.id)).filter((i) => i.type === 'approval')
    }
    const first = await turn(false)
    svc.answer(c.id, (await cardsOf(1))[0].id, 'allow-once')
    first.s.end!()
    await first.p
    const second = await turn(false)
    expect(svc.pendingCount(c.id)).toBe(1)
    const cards = await cardsOf(2)
    expect(new Set(cards.map((i) => i.id)).size).toBe(2)
    svc.answer(c.id, cards[1].id, 'deny')
    expect(sent).toHaveLength(2)
    expect(sent[0]).toEqual(allowResponse('0', input))
    expect(sent[1]).toMatchObject({ response: { request_id: '0', response: { behavior: 'deny' } } })
    expect(svc.pendingCount(c.id)).toBe(0)
    second.s.end!()
    await second.p
    // Codex's own cancel finds its card under the attempt's id.
    const third = await turn(true)
    await vi.waitFor(() => expect(svc.pendingCount(c.id)).toBe(0))
    third.s.end!()
    await third.p
    expect((await itemsOf(c.id)).filter((i) => i.type === 'approval').map((i) => i.type === 'approval' && i.status)).toEqual([
      'allowed-once',
      'denied',
      'unanswered'
    ])
    // One fresh tag per attempt.
    const tags = codexCalls.map((o) => o.requestTag)
    expect(tags.every((t) => typeof t === 'string' && t.length > 0)).toBe(true)
    expect(new Set(tags).size).toBe(3)
  })

  it('a Codex context fills the meter but never keep warm', async () => {
    const seen: string[] = []
    svc = withCodex({
      onContext: (chatId) => {
        seen.push(chatId)
      }
    })
    const c = await store.create('cx', dir)
    scripts.push({
      events: [
        { kind: 'init', sessionId: 's1' },
        { kind: 'context', model: DEF.model, tokens: 150_000 },
        { kind: 'assistantText', text: 'pong' },
        { ...(okResult as object), windows: { [DEF.model]: 258400 } } as RunEvent
      ]
    })
    await svc.send(c.id, 'ping')
    expect(seen).toEqual([])
    expect((await store.get(c.id))?.context).toMatchObject({ used: 150_000, window: 258400 })
  })

  it("records the result's cost as the run's own, and never asks the Claude logs for a run without one", async () => {
    const costs: RunCostEvent[] = []
    const without = vi.fn()
    const costBaseline = vi.fn(async () => null)
    svc = withCodex({
      onRunCost: (e) => {
        costs.push(e)
      },
      onRunWithoutCost: without,
      costBaseline
    })
    const c = await store.create('cx', dir)
    await store.update(c.id, { sessionId: 'th-1', sessionEngine: 'codex' })
    const cost = { totalUsd: 0.01, models: { [DEF.model]: { input: 10, cacheRead: 0, cacheWrite: 0, output: 5, costUsd: 0.01 } } }
    scripts.push(
      {
        events: [
          { kind: 'init', sessionId: 'th-1' },
          { kind: 'assistantText', text: 'pong' },
          { ...(okResult as object), sessionId: 'th-1', uuid: 'turn-1', cost } as RunEvent
        ]
      },
      {
        events: [
          { kind: 'init', sessionId: 'th-1' },
          { kind: 'assistantText', text: 'pong' },
          { ...(okResult as object), sessionId: 'th-1' } as RunEvent
        ]
      }
    )
    await svc.send(c.id, 'one')
    expect(costs).toEqual([expect.objectContaining({ id: 'turn-1', chatId: c.id, agent: 'cx', sessionId: 'th-1', cost })])
    await svc.send(c.id, 'two')
    expect(costs).toHaveLength(1)
    expect(costBaseline).not.toHaveBeenCalled()
    expect(without).not.toHaveBeenCalled()
  })

  it('a usage limit stamps the error with its reset, as for Claude', async () => {
    const c = await store.create('cx', dir)
    const failed: RunEvent = {
      kind: 'result',
      subtype: 'failed',
      isError: true,
      numTurns: 1,
      sessionId: 's1',
      denials: [],
      windows: {},
      uuid: null,
      cost: null
    }
    scripts.push({
      events: [{ kind: 'init', sessionId: 's1' }, { kind: 'limited', resetsAt: 5_000_000 }, failed],
      outcome: { result: failed as RunOutcome['result'], stderr: 'You have hit your usage limit.' }
    })
    await svc.send(c.id, 'ping')
    expect(codexCalls).toHaveLength(1)
    expect(await lastError(c.id)).toMatchObject({ text: 'You have hit your usage limit.', limit: { resetsAt: 5_000_000 } })
  })

  it('Compact on a Codex chat compacts its thread, adds no items, and the meter gets compacted', async () => {
    const c = await store.create('cx', dir)
    await store.update(c.id, { sessionId: 'th-1', sessionEngine: 'codex' })
    await store.saveItems(c.id, prior)
    scripts.push({
      events: [
        { kind: 'compacting', on: true },
        { kind: 'init', sessionId: 'th-1' },
        { kind: 'compacting', on: false },
        { kind: 'compacted', pre: 90_000, post: 4_000 },
        { ...okResult, windows: { m: 200_000 } } as RunEvent
      ]
    })
    await svc.compact(c.id, 'keep the bug list')
    expect(calls).toHaveLength(0)
    expect(codexCalls).toHaveLength(1)
    expect(codexCalls[0]).toMatchObject({ start: { kind: 'resume', threadId: 'th-1' }, action: { kind: 'compact' } })
    expect(await itemsOf(c.id)).toEqual(prior)
    const meta = await store.get(c.id)
    expect(meta).toMatchObject({ inFlight: false, sessionId: 'th-1', sessionEngine: 'codex', context: { used: null } })
    // Codex never reports the size after a compaction, so the meter names none (no "0 → 0").
    expect(meta?.context?.compacted).toBeUndefined()
    expect(meta?.compacting).toBeUndefined()
  })

  it('compact with no compacted event clears compacting', async () => {
    const c = await store.create('cx', dir)
    await store.update(c.id, { sessionId: 'th-1', sessionEngine: 'codex' })
    // Stopped once the run is up, not after a fixed tick: a Stop before it starts ends the compaction without taking this
    // script, and the next compact below would then get it and hang (seen on a loaded CI runner).
    let ready: () => void = () => {}
    const reached = new Promise<void>((r) => {
      ready = r
    })
    scripts.push({
      hang: true,
      ready,
      events: [
        { kind: 'compacting', on: true },
        { kind: 'init', sessionId: 'th-1' }
      ]
    })
    const p = svc.compact(c.id, '')
    await reached
    expect((await store.get(c.id))?.compacting).toBe(true)
    svc.stop(c.id)
    await p
    expect(await store.get(c.id)).toMatchObject({ inFlight: false, sessionId: 'th-1' })
    expect((await store.get(c.id))?.compacting).toBeUndefined()
    scripts.push({ outcome: { exitCode: 1, stderr: 'boom', result: null } })
    await svc.compact(c.id, '')
    expect((await store.get(c.id))?.compacting).toBeUndefined()
    expect(svc.isRunning(c.id)).toBe(false)
  })

  it('a Codex chat with no thread has nothing to compact, and a Claude agent has nothing to compact in a Codex session', async () => {
    const fresh = await store.create('cx', dir)
    await expect(svc.compact(fresh.id, '')).rejects.toThrow(NOTHING_TO_COMPACT)
    const h = await store.create('helper', dir)
    await store.update(h.id, { sessionId: 'th-2', sessionEngine: 'codex' })
    await expect(svc.compact(h.id, '')).rejects.toThrow(NOTHING_TO_COMPACT)
    expect(calls).toHaveLength(0)
    expect(codexCalls).toHaveLength(0)
  })

  it("the agent's compact window reaches Codex as the thread's auto-compact limit only below the model's window, never as the Claude env var", async () => {
    let window: number | null = 400_000
    svc = withCodex({ compactWindow: async () => window })
    // A Codex turn that reports its model's window, as the runner does: a context event naming the model, then the result.
    const turnWithWindow = (n: number): Script => ({
      events: [
        { kind: 'init', sessionId: 's1' },
        { kind: 'context', model: DEF.model, tokens: 1000 },
        { kind: 'assistantText', text: 'hi' },
        { kind: 'entry', uuid: `turn-${n}` },
        { ...okResult, windows: { [DEF.model]: 258_400 } }
      ]
    })
    const c = await store.create('cx', dir)
    // The window is not known yet (the chat's first turn): only a limit below the 200K floor is sent.
    scripts.push(turnWithWindow(1))
    await svc.send(c.id, 'hello')
    expect(codexCalls[0].thread.autoCompactTokenLimit).toBeUndefined()
    expect(codexCalls[0].env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined()
    expect((await store.get(c.id))?.context?.window).toBe(258_400)
    const fresh = await store.create('cx', dir)
    window = 150_000
    await svc.send(fresh.id, 'hello')
    expect(codexCalls[1].thread.autoCompactTokenLimit).toBe(150_000)
    // Known now (258 400): sent only below it.
    window = 200_000
    scripts.push(turnWithWindow(2))
    await svc.send(c.id, 'again')
    expect(codexCalls[2].thread.autoCompactTokenLimit).toBe(200_000)
    for (const at of [258_400, 400_000]) {
      window = at
      scripts.push(turnWithWindow(3))
      await svc.send(c.id, 'more')
      expect(codexCalls.at(-1)!.thread.autoCompactTokenLimit).toBeUndefined()
    }
    window = null
    await svc.send(c.id, 'third')
    expect(codexCalls.at(-1)!.thread.autoCompactTokenLimit).toBeUndefined()
  })

  it('a window a Claude session left counts as not known on the reseed that leaves it for Codex', async () => {
    svc = withCodex({ compactWindow: async () => 400_000 })
    const c = await store.create('cx', dir)
    // Claude's 1M window: 400K is below it, but not below the 258 400 tokens a Codex model may have.
    await store.update(c.id, { sessionId: 'claude-s', context: { used: 1000, window: 1_000_000 } })
    await store.saveItems(c.id, prior)
    await svc.send(c.id, 'ping')
    expect(threadOf(codexCalls[0])).toBeNull()
    expect(codexCalls[0].thread.autoCompactTokenLimit).toBeUndefined()
  })

  describe('a Codex feature turned off (a later probe failed): its Phase 1 behaviour comes back', () => {
    const off = (...flags: (keyof EngineCaps)[]) =>
      withCodex({
        snapshots: new SnapshotStore(join(dir, 'snap')),
        readFile: async (p) => fs.readFile(p),
        caps: (e) => ({ ...engineCaps(e), ...(e === 'codex' ? Object.fromEntries(flags.map((f) => [f, false])) : {}) })
      })

    it('compact off: no auto-compact limit reaches the thread, whatever the agent and the window say', async () => {
      svc = withCodex({
        compactWindow: async () => 150_000,
        caps: (e) => ({ ...engineCaps(e), ...(e === 'codex' ? { compact: false } : {}) })
      })
      const c = await store.create('cx', dir)
      await store.update(c.id, { sessionId: 'th-1', sessionEngine: 'codex', context: { used: 1000, window: 258_400 } })
      await svc.send(c.id, 'hello')
      expect(codexCalls[0].thread.autoCompactTokenLimit).toBeUndefined()
      // On, the same chat sends it.
      svc = withCodex({ compactWindow: async () => 150_000 })
      await svc.send(c.id, 'again')
      expect(codexCalls[1].thread.autoCompactTokenLimit).toBe(150_000)
    })

    it('rewind off: a cut point starts a fresh thread from the history with the expired notice, never a fork', async () => {
      svc = off('rewind')
      const c = await store.create('cx', dir)
      await store.update(c.id, { sessionId: 'th-1', sessionEngine: 'codex', next: { at: 'turn-1' } })
      await store.saveItems(c.id, prior)
      scripts.push(cxTurn('th-2', 'pong', 'turn-2'))
      await svc.send(c.id, 'ping')
      expect(codexCalls.map((o) => o.start)).toEqual([{ kind: 'new' }])
      expect(promptOf(codexCalls[0])).toBe(buildSeedPrompt(prior, 'ping'))
      expect(kinds(await itemsOf(c.id))).toEqual(['user', 'assistant', 'user', 'notice:expired', 'assistant'])
      expect(await store.get(c.id)).toMatchObject({ sessionId: 'th-2', sessionEngine: 'codex' })
    })

    it('rewind off: an edit reseeds too, and a cut point has nothing to compact', async () => {
      svc = off('rewind')
      scripts.push(cxTurn('th-1', 'a1', 'turn-1'), cxTurn('th-1', 'a2', 'turn-2'))
      const c = await store.create('cx', dir)
      await svc.send(c.id, 'one')
      await svc.send(c.id, 'two')
      const items = await itemsOf(c.id)
      await store.update(c.id, { next: { at: 'turn-1' } })
      await expect(svc.compact(c.id, '')).rejects.toThrow(NOTHING_TO_COMPACT)
      await svc.rerun(c.id, items[2].id, 'two, edited')
      expect(codexCalls.map((o) => o.start.kind)).toEqual(['new', 'resume', 'new'])
      expect(promptOf(codexCalls[2])).toBe(buildSeedPrompt(items.slice(0, 2), 'two, edited'))
    })

    it('compact off: Compact is refused with the fixed sentence and runs nothing', async () => {
      svc = off('compact')
      const c = await store.create('cx', dir)
      await store.update(c.id, { sessionId: 'th-1', sessionEngine: 'codex' })
      await expect(svc.compact(c.id, '')).rejects.toThrow(CODEX_REFUSALS.compact)
      expect(codexCalls).toHaveLength(0)
      expect(await store.get(c.id)).toMatchObject({ inFlight: false })
      // A Claude chat on the same server still compacts.
      const h = await store.create('helper', dir)
      await store.update(h.id, { sessionId: 's1' })
      await svc.compact(h.id, '')
      expect(calls).toHaveLength(1)
    })

    it('files off: an ApplyPatch result records no change', async () => {
      svc = off('files')
      const c = await store.create('cx', dir)
      scripts.push({
        events: [
          { kind: 'init', sessionId: 's1' },
          { kind: 'toolUse', id: 'p1', name: 'ApplyPatch', input: { changes: [{ path: join(dir, 'b.txt'), kind: 'add' }] } },
          {
            kind: 'toolResult',
            toolUseId: 'p1',
            content: 'ok',
            isError: false,
            detail: { codexChanges: [{ path: join(dir, 'b.txt'), kind: 'add', movePath: null, diff: 'brand new\n' }] }
          },
          okResult
        ]
      })
      await svc.send(c.id, 'go')
      const tool = (await itemsOf(c.id)).find((i) => i.type === 'tool')
      expect(tool).toMatchObject({ type: 'tool', name: 'ApplyPatch' })
      expect(tool?.type === 'tool' && tool.changes).toBeFalsy()
    })

    it('files on (the default): the same result records its change', async () => {
      svc = off()
      const c = await store.create('cx', dir)
      scripts.push({
        events: [
          { kind: 'init', sessionId: 's1' },
          { kind: 'toolUse', id: 'p1', name: 'ApplyPatch', input: { changes: [{ path: join(dir, 'b.txt'), kind: 'add' }] } },
          {
            kind: 'toolResult',
            toolUseId: 'p1',
            content: 'ok',
            isError: false,
            detail: { codexChanges: [{ path: join(dir, 'b.txt'), kind: 'add', movePath: null, diff: 'brand new\n' }] }
          },
          okResult
        ]
      })
      await svc.send(c.id, 'go')
      await vi.waitFor(async () => {
        const tool = (await itemsOf(c.id)).find((i) => i.type === 'tool')
        expect(tool?.type === 'tool' && tool.changes?.length).toBe(1)
      })
    })

    it('questions off: codex runs without the question feature; on by default', async () => {
      const c = await store.create('cx', dir)
      await svc.send(c.id, 'one')
      expect(codexCalls[0].questions).toBeUndefined()
      svc = off('questions')
      await svc.send(c.id, 'two')
      expect(codexCalls[1].questions).toBe(false)
    })

    it('btw off: a Codex turn leaves no side base, while a Claude one still does', async () => {
      svc = off('btw')
      const c = await store.create('cx', dir)
      await svc.send(c.id, 'one')
      expect(svc.sideBase(c.id, 'cx')).toBeNull()
      const h = await store.create('helper', dir)
      await svc.send(h.id, 'one')
      expect(svc.sideBase(h.id, 'helper')).not.toBeNull()
    })
  })

  it("an ask to a Codex agent runs on Codex, with the asked paragraph after the agent's body", async () => {
    const a = await store.create('helper', dir)
    const b0 = await store.create('cx', dir)
    const b = await store.update(b0.id, {
      asked: { by: 'helper', from: a.id, fromTitle: 'Issue chat', chain: [] },
      title: '@helper · Issue chat'
    })
    const out = await svc.runAsked(b.id, {
      from: 'helper',
      message: 'make a card',
      chain: ['helper'],
      parent: a.id,
      signal: new AbortController().signal
    })
    expect(out).toEqual({ kind: 'ok', reply: 'pong' })
    expect(calls).toHaveLength(0)
    expect(codexCalls).toHaveLength(1)
    expect(promptOf(codexCalls[0])).toBe('make a card')
    expect(codexCalls[0].thread.baseInstructions).toBe([DEF.body, askedSystem('helper', 'Issue chat')].join('\n\n'))
  })

  it('a Codex base replaces the Claude one left from before the agent moved to Codex, and the other way round', async () => {
    const c = await store.create('flip', dir)
    await svc.send(c.id, 'one')
    expect(svc.sideBase(c.id, 'flip')?.codex).toBeUndefined()
    codexAgents.add('flip')
    scripts.push({ hang: true, events: [] })
    const two = svc.send(c.id, 'two')
    await vi.waitFor(() => expect(codexCalls).toHaveLength(1))
    // Before the attempt publishes its own: the Claude base must not stand in for the Codex turn.
    const during = svc.sideBase(c.id, 'flip')
    expect(during === null || during.codex !== undefined).toBe(true)
    svc.stop(c.id)
    await two
    expect(svc.sideBase(c.id, 'flip')).toMatchObject({ codex: { at: null }, live: null, start: null })
    codexAgents.delete('flip')
    await svc.send(c.id, 'three')
    expect(svc.sideBase(c.id, 'flip')?.codex).toBeUndefined()
  })

  it("while a Codex turn runs, its side base names the last completed turn, never the running one's", async () => {
    const c = await store.create('cx', dir)
    scripts.push({
      events: [{ kind: 'init', sessionId: 's1' }, { kind: 'assistantText', text: 'one' }, { kind: 'entry', uuid: 'turn-1' }, okResult]
    })
    await svc.send(c.id, 'one')
    expect((await itemsOf(c.id)).at(-1)?.end).toEqual({ session: 's1', at: 'turn-1', engine: 'codex' })
    expect(svc.sideBase(c.id, 'cx')).toMatchObject({ active: false, codex: { threadId: '', at: null } })
    let ready!: () => void
    const running = new Promise<void>((r) => {
      ready = r
    })
    // The running turn's own entry comes with its end: it must not move the point while the turn runs.
    scripts.push({
      hang: true,
      ready,
      events: [
        { kind: 'init', sessionId: 's1' },
        { kind: 'textDelta', text: 'wor' },
        { kind: 'entry', uuid: 'turn-2' }
      ]
    })
    const two = svc.send(c.id, 'two')
    await running
    expect(svc.sideBase(c.id, 'cx')).toMatchObject({ active: true, live: null, start: null, codex: { threadId: 's1', at: 'turn-1' } })
    // A side question now forks that turn, in a process of its own: the main run's options stay as they were.
    const main = JSON.stringify(codexCalls[1])
    const sideRuns: CodexRunOptions[] = []
    const side = new SideQuestions({
      store,
      chats: svc,
      groups: {
        refuseCodex: async () => {},
        sideThread: async () => [],
        pickInput: async () => {
          throw new Error('Not a room')
        }
      },
      pick: async () => null,
      baseFor: async () => null,
      run: () => {
        throw new Error('no Claude side run')
      },
      codexRun: (o) => {
        sideRuns.push(o)
        const done = new Promise<RunOutcome>((resolve) =>
          setImmediate(() => {
            o.onEvent({ kind: 'assistantText', text: 'Halfway' })
            resolve(baseOutcome())
          })
        )
        return { stop: () => {}, send: () => true, done }
      },
      broadcast: () => {},
      recordCost: () => {},
      now: () => Date.now()
    })
    await side.ask(c.id, 'How far?', 'q')
    await vi.waitFor(async () => expect((await side.list(c.id))[0]).toMatchObject({ state: 'done', answer: 'Halfway' }))
    expect(sideRuns).toHaveLength(1)
    expect(sideRuns[0]).toMatchObject({
      bin: '/bin/codex',
      start: { kind: 'fork', threadId: 's1', lastTurnId: 'turn-1', ephemeral: true },
      thread: { permissionMode: 'manual', sandbox: 'read-only', model: DEF.model }
    })
    expect(codexCalls).toHaveLength(2)
    expect(JSON.stringify(codexCalls[1])).toBe(main)
    svc.stop(c.id)
    await two
    expect(svc.sideBase(c.id, 'cx')?.active).toBe(false)
    await side.stopAll()
  })

  describe('the vault guard and API keys', () => {
    const KEY = 'tok-secret-ABCD1234'
    const ENV_NAME = 'CB_TEST_VAULT_KEY'
    const HOOKS = codexVaultHooks({ keyFile: '/h/.config/zumibot-vault/vault.key', vaultFile: '/d/vault.json', home: '/h' })
    const keyed: Partial<ChatServiceDeps> = {
      vaultEnv: () => ({ env: { [ENV_NAME]: KEY }, scrub: new Map([[KEY, '[vault: Azure PAT]']]) })
    }
    const guarded = (extra: Partial<ChatServiceDeps> = {}) => withCodex({ ...keyed, codexVaultHooks: HOOKS, ...extra })
    const untrusted = (): Script => ({ outcome: { hooksUntrusted: true, result: null } })
    // What each run was started with: its hooks, whether its trust was asked afresh, and whether the key was in its env.
    const shape = (o: CodexRunOptions) => ({
      hooks: o.thread.hooks ?? null,
      fresh: o.freshHookTrust ?? false,
      key: o.env?.[ENV_NAME] === KEY
    })
    const keyless = (o: CodexRunOptions) => expect(JSON.stringify(o)).not.toContain(KEY)

    it("a Codex turn's thread carries the vault hooks, and a granted key goes first in its env and is scrubbed from the reply", async () => {
      svc = guarded({ todoTurns: allBridges().todoTurns })
      const c = await store.create('cx', dir)
      scripts.push({
        events: [
          { kind: 'init', sessionId: 's1' },
          { kind: 'textDelta', text: `The key is ${KEY.slice(0, 7)}` },
          { kind: 'textDelta', text: `${KEY.slice(7)} ok` },
          { kind: 'assistantText', text: `The key is ${KEY} ok` },
          okResult
        ]
      })
      await svc.send(c.id, 'print the key')
      expect(codexCalls).toHaveLength(1)
      const o = codexCalls[0]
      expect(shape(o)).toEqual({ hooks: HOOKS, fresh: false, key: true })
      // The hook pre-flight starts no model and needs none of the run's own values: only the base env, the keys least of all.
      expect(o.hookTrustEnv).toEqual({})
      // First, as on Claude: no key's name can stand in for a value the server sets for the run.
      expect(Object.keys(o.env!)[0]).toBe(ENV_NAME)
      expect(o.env).toMatchObject({ ZUMIBOT_TODOS_CAPABILITY: 'todo-cap' })
      const items = await itemsOf(c.id)
      expect(items.find((i) => i.type === 'assistant')).toMatchObject({ text: 'The key is [vault: Azure PAT] ok' })
      expect(JSON.stringify(items)).not.toContain(KEY)
      expect(JSON.stringify(pushes)).not.toContain(KEY)
    })

    it('a run whose hooks could not be built gets no key, though its output is still scrubbed of it', async () => {
      for (const extra of [{}, { codexVaultHooks: [] }] as Partial<ChatServiceDeps>[]) {
        codexCalls = []
        svc = withCodex({ ...keyed, ...extra })
        const c = await store.create('cx', dir)
        scripts.push({ events: [{ kind: 'init', sessionId: 's1' }, { kind: 'assistantText', text: `got ${KEY}` }, okResult] })
        await svc.send(c.id, 'hello')
        expect(shape(codexCalls[0])).toEqual({ hooks: null, fresh: false, key: false })
        keyless(codexCalls[0])
        expect((await itemsOf(c.id)).find((i) => i.type === 'assistant')).toMatchObject({ text: 'got [vault: Azure PAT]' })
      }
    })

    it('with the vaultKeys cap off, a Codex run gets neither the hooks nor the key, while a Claude run keeps its guard and key', async () => {
      svc = guarded({
        vaultGuard: '{"permissions":{}}',
        caps: (e) => ({ ...engineCaps(e), ...(e === 'codex' ? { vaultKeys: false } : {}) })
      })
      const c = await store.create('cx', dir)
      await svc.send(c.id, 'hello')
      expect(shape(codexCalls[0])).toEqual({ hooks: null, fresh: false, key: false })
      keyless(codexCalls[0])
      const h = await store.create('helper', dir)
      await svc.send(h.id, 'hello')
      expect(calls[0].env?.[ENV_NAME]).toBe(KEY)
      expect(calls[0].args.join(' ')).toContain('--settings')
    })

    it('Compact gets neither the hooks nor the key', async () => {
      svc = guarded()
      const c = await store.create('cx', dir)
      await store.update(c.id, { sessionId: 'th-1', sessionEngine: 'codex' })
      scripts.push({
        events: [{ kind: 'compacting', on: true }, { kind: 'init', sessionId: 'th-1' }, { kind: 'compacting', on: false }, okResult]
      })
      await svc.compact(c.id, '')
      expect(codexCalls[0].action).toEqual({ kind: 'compact' })
      expect(shape(codexCalls[0])).toEqual({ hooks: null, fresh: false, key: false })
      keyless(codexCalls[0])
    })

    it('an A→B asked run and a routine run carry the hooks and the key, as a typed message does', async () => {
      svc = guarded()
      const a = await store.create('helper', dir)
      const b0 = await store.create('cx', dir)
      const b = await store.update(b0.id, {
        asked: { by: 'helper', from: a.id, fromTitle: 'Issue chat', chain: [] },
        title: '@helper · Issue chat'
      })
      expect(
        await svc.runAsked(b.id, {
          from: 'helper',
          message: 'make a card',
          chain: ['helper'],
          parent: a.id,
          signal: new AbortController().signal
        })
      ).toEqual({ kind: 'ok', reply: 'pong' })
      const r = await store.create('cx', dir)
      await svc.send(r.id, 'tick', [], undefined, undefined, undefined, undefined, true)
      expect(codexCalls).toHaveLength(2)
      expect(codexCalls.map(shape)).toEqual([
        { hooks: HOOKS, fresh: false, key: true },
        { hooks: HOOKS, fresh: false, key: true }
      ])
    })

    it('a guard codex trusts on the second ask runs then, hooks and key as before', async () => {
      svc = guarded()
      const c = await store.create('cx', dir)
      scripts.push(untrusted(), { events: pong })
      await svc.send(c.id, 'hello')
      expect(codexCalls.map(shape)).toEqual([
        { hooks: HOOKS, fresh: false, key: true },
        { hooks: HOOKS, fresh: true, key: true }
      ])
      expect(kinds(await itemsOf(c.id))).toEqual(['user', 'assistant'])
    })

    it('a guard codex never trusts: once more with its trust asked afresh, then without the hooks or the key, logged by code only', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        svc = guarded()
        const c = await store.create('cx', dir)
        scripts.push(untrusted(), untrusted(), {
          events: [{ kind: 'init', sessionId: 's1' }, { kind: 'assistantText', text: `pong ${KEY}` }, okResult]
        })
        await svc.send(c.id, 'hello')
        expect(codexCalls.map(shape)).toEqual([
          { hooks: HOOKS, fresh: false, key: true },
          { hooks: HOOKS, fresh: true, key: true },
          { hooks: null, fresh: false, key: false }
        ])
        keyless(codexCalls[2])
        // The user's turn still runs, with no error, after a notice naming what it runs without; the value is still scrubbed.
        const items = await itemsOf(c.id)
        expect(kinds(items)).toEqual(['user', 'notice:unguarded', 'assistant'])
        expect(items[1]).toMatchObject({
          text: "Codex didn't confirm ZumiBot's hooks, so this reply runs without the vault guard or the agent's API keys."
        })
        expect(items.find((i) => i.type === 'assistant')).toMatchObject({ text: 'pong [vault: Azure PAT]' })
        expect(await store.get(c.id)).toMatchObject({ sessionId: 's1', sessionEngine: 'codex', inFlight: false })
        const lines = log.mock.calls.map((a) => a.map(String).join(' '))
        expect(lines.filter((l) => /codex hooks not confirmed/i.test(l))).toHaveLength(1)
        for (const l of lines)
          for (const secret of [KEY, ENV_NAME, 'Azure PAT', '/h/', 'vault.key', 'vault.json']) expect(l).not.toContain(secret)
      } finally {
        log.mockRestore()
      }
    })

    it('a Stop during the guarded run starts no second run', async () => {
      svc = guarded()
      const c = await store.create('cx', dir)
      let ready!: () => void
      const held = new Promise<void>((r) => {
        ready = r
      })
      scripts.push({ hang: true, ready, outcome: { hooksUntrusted: true, result: null } })
      const p = svc.send(c.id, 'hello')
      await held
      svc.stop(c.id)
      await p
      expect(codexCalls).toHaveLength(1)
      expect(kinds(await itemsOf(c.id))).toEqual(['user', 'notice:stopped'])
    })

    it('a Stop that lands as the untrusted run ends starts no second run either', async () => {
      svc = guarded()
      const c = await store.create('cx', dir)
      let ready!: () => void
      const held = new Promise<void>((r) => {
        ready = r
      })
      const s: Script = { hang: true, ready, outcome: { hooksUntrusted: true, result: null } }
      scripts.push(s)
      const p = svc.send(c.id, 'hello')
      await held
      // The run ends untrusted, then the Stop comes before the turn reads that outcome.
      s.end!()
      svc.stop(c.id)
      await p
      expect(codexCalls).toHaveLength(1)
      expect(kinds(await itemsOf(c.id))).toEqual(['user', 'notice:stopped'])
    })

    it('a to-do note no thread read is never marked seen: a Stop during the guard check, or right after an untrusted run', async () => {
      const todos = new TodoService({ store, now: () => 5000, newId: () => `td${++n}`, onChanged: () => {} })
      const seen = vi.spyOn(todos, 'markSeen')
      svc = guarded({ todos })
      const c = await store.create('cx', dir)
      let ready!: () => void
      // Stopped while the guard is checked: no thread, so the run sends nothing.
      let held = new Promise<void>((r) => {
        ready = r
      })
      scripts.push({ hang: true, ready })
      let p = svc.send(c.id, 'one')
      await held
      svc.stop(c.id)
      await p
      // Stopped as an untrusted run ends: no rerun, so no thread either.
      held = new Promise<void>((r) => {
        ready = r
      })
      const s: Script = { hang: true, ready, outcome: { hooksUntrusted: true, result: null } }
      scripts.push(s)
      p = svc.send(c.id, 'two')
      await held
      s.end!()
      svc.stop(c.id)
      await p
      expect(codexCalls).toHaveLength(2)
      expect(seen).not.toHaveBeenCalled()
      // A run that started its thread read the note.
      await svc.send(c.id, 'three')
      expect(seen).toHaveBeenCalledTimes(1)
      expect(seen).toHaveBeenCalledWith(c.id, 'cx', 0)
    })

    it('a key under a name codex reads itself (CODEX_…, OPENAI_…) never reaches a Codex run but is still scrubbed; a Claude run keeps it', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const OWN = 'sk-own-SECRET-9876',
          HOME = '/elsewhere-secret-home'
        svc = guarded({
          vaultGuard: '{"permissions":{}}',
          vaultEnv: () => ({
            env: { [ENV_NAME]: KEY, OPENAI_API_KEY: OWN, CODEX_HOME: HOME },
            scrub: new Map([
              [KEY, '[vault: Azure PAT]'],
              [OWN, '[vault: OpenAI]'],
              [HOME, '[vault: Home]']
            ])
          })
        })
        const c = await store.create('cx', dir)
        scripts.push({ events: [{ kind: 'init', sessionId: 's1' }, { kind: 'assistantText', text: `own ${OWN} at ${HOME}` }, okResult] })
        await svc.send(c.id, 'hello')
        const o = codexCalls[0]
        expect(o.env?.[ENV_NAME]).toBe(KEY)
        expect(Object.keys(o.env!).filter((k) => /^(CODEX|OPENAI)_/.test(k))).toEqual([])
        expect(JSON.stringify(o)).not.toContain(OWN)
        expect(JSON.stringify(o)).not.toContain(HOME)
        expect((await itemsOf(c.id)).find((i) => i.type === 'assistant')).toMatchObject({ text: 'own [vault: OpenAI] at [vault: Home]' })
        const lines = log.mock.calls.map((a) => a.map(String).join(' '))
        expect(lines.filter((l) => /left out of a Codex run/.test(l))).toHaveLength(1)
        for (const l of lines)
          for (const secret of [OWN, HOME, KEY, 'OPENAI_API_KEY', 'CODEX_HOME', ENV_NAME, 'OpenAI']) expect(l).not.toContain(secret)
        // A Claude agent keeps such keys: its CLI does not read them.
        const h = await store.create('helper', dir)
        await svc.send(h.id, 'hello')
        expect(calls[0].env).toMatchObject({ [ENV_NAME]: KEY, OPENAI_API_KEY: OWN, CODEX_HOME: HOME })
      } finally {
        log.mockRestore()
      }
    })

    describe('against the fake codex', () => {
      const fake = fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url))
      const lines = (p: string) =>
        existsSync(p)
          ? readFileSync(p, 'utf8')
              .split('\n')
              .filter(Boolean)
              .map((l) => JSON.parse(l) as { method: string; params: any })
          : []
      // A process started with the key in its env logs its requests to with-key.jsonl, one without to no-key.jsonl, so a
      // test can tell which process opened a thread. `moved`: a process given a trust table hashes with another salt, so it
      // reports ZumiBot's hook untrusted, as a codex that changed its hashing would.
      const shimOf = (moved: boolean) =>
        writePreludeBin(
          dir,
          'codex-shim',
          [
            "import { appendFileSync } from 'node:fs'",
            "const all = process.argv.slice(2).join(' ')",
            ...(moved ? ["if (all.includes('hooks.state=')) process.env.FAKE_CODEX_HOOK_SALT = 'moved'"] : []),
            // One line per process: whether it got hooks, a trust table (a pre-flight gets none) and the key.
            `const key = ${JSON.stringify(ENV_NAME)} in process.env`,
            `appendFileSync(${JSON.stringify(join(dir, 'procs.jsonl'))}, JSON.stringify({ hooks: all.includes('hooks.PreToolUse='), trusted: all.includes('hooks.state='), key }) + '\\n')`,
            `process.env.FAKE_CODEX_LOG = key ? ${JSON.stringify(join(dir, 'with-key.jsonl'))} : ${JSON.stringify(join(dir, 'no-key.jsonl'))}`
          ].join('\n'),
          fake
        )
      const fakeCodex = (bin: string, script: unknown[], hooks = HOOKS): Partial<ChatServiceDeps> => {
        const scriptFile = join(dir, 'codex-script.jsonl')
        writeFileSync(scriptFile, script.map((s) => JSON.stringify(s)).join('\n') + '\n')
        const home = join(dir, 'codex-home')
        mkdirSync(join(home, 'threads'), { recursive: true })
        codexBin = bin
        return {
          ...keyed,
          codexVaultHooks: hooks,
          codex: {
            locate: async () => bin,
            // As app.ts does: the base env under the run's own and under the pre-flight's.
            run: (o) => {
              codexCalls.push(o)
              const base = { ...process.env, FAKE_CODEX_HOME: home, FAKE_CODEX_SCRIPT: scriptFile }
              return runCodex({
                ...o,
                env: { ...base, ...o.env },
                ...(o.hookTrustEnv ? { hookTrustEnv: { ...base, ...o.hookTrustEnv } } : {})
              })
            },
            definitionOf: async () => ({ ...DEF })
          }
        }
      }
      const message = (text: string) => ({
        notify: {
          method: 'item/completed',
          params: { threadId: '$THREAD', turnId: '$TURN', item: { type: 'agentMessage', id: 'm1', text } }
        }
      })

      it("an auto-run read of the key is blocked: the hook sees check 11's cat input and the row holds VAULT_GUARD_TEXT", async () => {
        const keyFile = join(dir, 'cfg', 'zumibot-vault', 'vault.key')
        const hooks = codexVaultHooks({ keyFile, vaultFile: join(dir, 'data', 'vault.json'), home: join(dir, 'home') })
        svc = withCodex(
          fakeCodex(
            shimOf(false),
            [
              { exec: { command: `cat ${keyFile}`, id: 'exec-read' } },
              { exec: { command: 'echo ok', output: 'ok\n', id: 'exec-ok' } },
              message('done')
            ],
            hooks
          )
        )
        const c = await store.create('cx', dir)
        await svc.send(c.id, 'read the key')
        const items = await itemsOf(c.id)
        const tools = items.filter((i): i is Extract<ChatItem, { type: 'tool' }> => i.type === 'tool')
        expect(tools.map((t) => t.name)).toEqual([CODEX_BLOCKED_TOOL, 'Bash'])
        expect(tools[0]).toMatchObject({ id: 'exec-read', result: VAULT_GUARD_TEXT, isError: true })
        expect(tools[1]).toMatchObject({ isError: false })
        expect(items.at(-1)).toMatchObject({ type: 'assistant', text: 'done' })
        // The pre-flight ran without the key; the thread ran in the trusted process holding it.
        expect(lines(join(dir, 'procs.jsonl'))).toEqual([
          { hooks: true, trusted: false, key: false },
          { hooks: true, trusted: true, key: true }
        ])
        expect(lines(join(dir, 'no-key.jsonl')).map((l) => l.method)).toEqual(['initialize', 'hooks/list'])
        expect(lines(join(dir, 'with-key.jsonl')).map((l) => l.method)).toEqual(['initialize', 'hooks/list', 'thread/start', 'turn/start'])
        expect(JSON.stringify(items)).not.toContain(KEY)
      }, 20_000)

      it('a hook the fake reports untrusted ends each guarded run before thread/start; the third run has no hooks and no key', async () => {
        const log = vi.spyOn(console, 'error').mockImplementation(() => {})
        try {
          svc = withCodex(fakeCodex(shimOf(true), [message('done')]))
          const c = await store.create('cx', dir)
          await svc.send(c.id, 'hello')
          expect(codexCalls.map(shape)).toEqual([
            { hooks: HOOKS, fresh: false, key: true },
            { hooks: HOOKS, fresh: true, key: true },
            { hooks: null, fresh: false, key: false }
          ])
          // Keyless pre-flights, then two keyed runs that listed the hooks and stopped there; only the keyless, hookless third
          // run opened a thread.
          expect(lines(join(dir, 'procs.jsonl'))).toEqual([
            { hooks: true, trusted: false, key: false },
            { hooks: true, trusted: true, key: true },
            { hooks: true, trusted: false, key: false },
            { hooks: true, trusted: true, key: true },
            { hooks: false, trusted: false, key: false }
          ])
          expect(lines(join(dir, 'with-key.jsonl')).map((l) => l.method)).toEqual(['initialize', 'hooks/list', 'initialize', 'hooks/list'])
          expect(lines(join(dir, 'no-key.jsonl')).map((l) => l.method)).toEqual([
            'initialize',
            'hooks/list',
            'initialize',
            'hooks/list',
            'initialize',
            'thread/start',
            'turn/start'
          ])
          expect(kinds(await itemsOf(c.id))).toEqual(['user', 'notice:unguarded', 'assistant'])
          expect(await store.get(c.id)).toMatchObject({ sessionEngine: 'codex', inFlight: false })
          expect(log.mock.calls.map((a) => a.map(String).join(' ')).filter((l) => /codex hooks not confirmed/i.test(l))).toHaveLength(1)
        } finally {
          log.mockRestore()
        }
      }, 30_000)
    })
  })

  describe('Pause', () => {
    const PAUSE_ENTRY = fileURLToPath(new URL('../fixtures/pause-hook-src.mjs', import.meta.url))
    const PAUSE_HOOK = codexPauseHook({ node: process.execPath, pauseHookEntry: PAUSE_ENTRY, electronNode: false })!
    const VAULT = codexVaultHooks({ keyFile: '/h/.config/zumibot-vault/vault.key', vaultFile: '/d/vault.json', home: '/h' })
    const KEY = 'tok-secret-ABCD1234'
    const ENV_NAME = 'CB_TEST_VAULT_KEY'
    const settings = pauseSettings({ node: '/opt/node', entry: '/opt/pauseHook.mjs', electronNode: false })
    let tmp: ChatTmp
    let ends: TurnEnd[]
    // As app.ts wires it: the Claude hook and the Codex one from the same entry, the vault's hooks and a granted key.
    const paused = (extra: Partial<ChatServiceDeps> = {}) => {
      tmp = new ChatTmp(join(dir, 'claude-tmp'))
      ends = []
      return withCodex({
        tmp,
        pauseHook: { settings },
        codexPauseHook: PAUSE_HOOK,
        codexVaultHooks: VAULT,
        onTurnEnd: (e) => ends.push(e),
        vaultEnv: () => ({ env: { [ENV_NAME]: KEY }, scrub: new Map([[KEY, '[vault: Azure PAT]']]) }),
        ...extra
      })
    }
    const queueOf = (chats: ChatService) =>
      new TaskQueue({
        store,
        chats,
        groups: { send: async () => {}, rerun: async () => {}, compact: async () => {}, requestPause: () => false, resume: async () => {} },
        files: { commit: async () => [], removeFiles: async () => {} },
        push: () => {},
        now: () => 5000,
        newId: () => `q${++n}`
      })
    const shape = (o: CodexRunOptions) => ({
      hooks: o.thread.hooks ?? null,
      fresh: o.freshHookTrust ?? false,
      key: o.env?.[ENV_NAME] === KEY,
      flag: o.env?.ZUMIBOT_PAUSE_FILE ?? null
    })
    // A blocked call as the mapper gives it: its row, with the response it came in, and the hook's text as its error.
    const blockedRow = (id: string, message: string): RunEvent[] => [
      { kind: 'toolUse', id, name: CODEX_BLOCKED_TOOL, input: {}, message },
      { kind: 'toolResult', toolUseId: id, content: PAUSE_BLOCK_TEXT, isError: true }
    ]
    const hang = (chatId: string, events: RunEvent[], outcome?: Partial<RunOutcome>) => {
      let ready!: () => void
      const reached = new Promise<void>((resolve) => {
        ready = resolve
      })
      const script: Script = { hang: true, events, ready, ...(outcome ? { outcome } : {}) }
      scripts.push(script)
      return { p: svc.send(chatId, 'go'), reached, script }
    }
    const pausing = async (chatId: string) => {
      await store.update(chatId, { pause: 'pausing' })
      await svc.setPauseFlag(chatId, true)
    }

    it("a Codex main run carries the pause hook after the vault's, trusted with them, and the chat's flag path in its env", async () => {
      svc = paused()
      const c = await store.create('cx', dir)
      await svc.send(c.id, 'hello')
      expect(shape(codexCalls[0])).toEqual({ hooks: [...VAULT, PAUSE_HOOK], fresh: false, key: true, flag: tmp.pauseFlagOf(c.id) })
      // The pre-flight that reads their trust still gets the base env alone.
      expect(codexCalls[0].hookTrustEnv).toEqual({})
      // The key still goes first: no key's name can stand in for the flag path the server sets.
      expect(Object.keys(codexCalls[0].env!)[0]).toBe(ENV_NAME)
      expect(await svc.canPause(c.id)).toBe(true)
    })

    it('an A→B asked run and a routine run carry the pause hook and the flag path too', async () => {
      svc = paused()
      const a = await store.create('helper', dir)
      const b0 = await store.create('cx', dir)
      const b = await store.update(b0.id, {
        asked: { by: 'helper', from: a.id, fromTitle: 'Issue chat', chain: [] },
        title: '@helper · Issue chat'
      })
      await svc.runAsked(b.id, {
        from: 'helper',
        message: 'make a card',
        chain: ['helper'],
        parent: a.id,
        signal: new AbortController().signal
      })
      const r = await store.create('cx', dir)
      await svc.send(r.id, 'tick', [], undefined, undefined, undefined, undefined, true)
      expect(codexCalls.map(shape)).toEqual([
        { hooks: [...VAULT, PAUSE_HOOK], fresh: false, key: true, flag: tmp.pauseFlagOf(b.id) },
        { hooks: [...VAULT, PAUSE_HOOK], fresh: false, key: true, flag: tmp.pauseFlagOf(r.id) }
      ])
    })

    it('the vaultKeys cap off leaves the pause hook alone, with no key; the pause cap off leaves the vault hooks alone, with no flag path', async () => {
      svc = paused({ caps: (e) => ({ ...engineCaps(e), ...(e === 'codex' ? { vaultKeys: false } : {}) }) })
      const c = await store.create('cx', dir)
      await svc.send(c.id, 'hello')
      expect(shape(codexCalls[0])).toEqual({ hooks: [PAUSE_HOOK], fresh: false, key: false, flag: tmp.pauseFlagOf(c.id) })
      expect(JSON.stringify(codexCalls[0])).not.toContain(KEY)
      svc = paused({ caps: (e) => ({ ...engineCaps(e), ...(e === 'codex' ? { pause: false } : {}) }) })
      await svc.send(c.id, 'again')
      expect(shape(codexCalls[1])).toEqual({ hooks: VAULT, fresh: false, key: true, flag: null })
      // A Claude run on the same server keeps its own hook, as before.
      const h = await store.create('helper', dir)
      await svc.send(h.id, 'hello')
      expect(calls[0].args.join(' ')).toContain('--settings')
      expect(calls[0].env?.ZUMIBOT_PAUSE_FILE).toBe(tmp.pauseFlagOf(h.id))
    })

    it('without the Codex hook a Codex run gets no pause hook and no flag path', async () => {
      svc = paused({ codexPauseHook: undefined })
      const c = await store.create('cx', dir)
      await svc.send(c.id, 'hello')
      expect(shape(codexCalls[0])).toEqual({ hooks: VAULT, fresh: false, key: true, flag: null })
    })

    it('Compact gets no pause hook and no flag path', async () => {
      svc = paused()
      const c = await store.create('cx', dir)
      await store.update(c.id, { sessionId: 'th-1', sessionEngine: 'codex' })
      scripts.push({
        events: [{ kind: 'compacting', on: true }, { kind: 'init', sessionId: 'th-1' }, { kind: 'compacting', on: false }, okResult]
      })
      await svc.compact(c.id, '')
      expect(codexCalls[0].action).toEqual({ kind: 'compact' })
      expect(shape(codexCalls[0])).toEqual({ hooks: null, fresh: false, key: false, flag: null })
    })

    it('a Pause through the queue: the flag is set, the blocked row carries the marker, the chat lands paused, and Resume sends Continue on the same thread', async () => {
      svc = paused({ onIdle: (id) => queue.idle(id) })
      const queue = queueOf(svc)
      const c = await store.create('cx', dir)
      await store.addTask(c.id, { id: 'later', text: 'later', ts: 1 })
      const { p, reached, script } = hang(c.id, [{ kind: 'init', sessionId: 'th-1' }])
      await reached
      await queue.pause(c.id)
      expect(existsSync(tmp.pauseFlagOf(c.id))).toBe(true)
      for (const e of blockedRow('exec-1', 'th-1:response-0')) emit(e)
      emit({ kind: 'assistantText', text: 'Paused before step 2; next is step 2.' })
      emit({ ...okResult, sessionId: 'th-1' })
      script.end!()
      await p
      await tick()
      const items = await itemsOf(c.id)
      expect(kinds(items)).toEqual(['user', 'tool', 'assistant', 'notice:userPaused'])
      expect(items[1]).toMatchObject({ name: CODEX_BLOCKED_TOOL, isError: true })
      expect((items[1] as Extract<ChatItem, { type: 'tool' }>).result).toContain(PAUSE_MARKER)
      expect(await store.get(c.id)).toMatchObject({
        pause: 'paused',
        held: true,
        inFlight: false,
        sessionId: 'th-1',
        sessionEngine: 'codex'
      })
      expect(existsSync(tmp.pauseFlagOf(c.id))).toBe(false)
      expect(ends).toEqual([{ chatId: c.id, agent: 'cx', outcome: 'ok', reply: expect.any(String) }])
      expect(codexCalls).toHaveLength(1)
      // Resume: Continue on the same thread, then the held task.
      await queue.resumePaused(c.id)
      await tick()
      expect(codexCalls[1].start).toEqual({ kind: 'resume', threadId: 'th-1' })
      expect(promptOf(codexCalls[1])).toBe(RESUME_TEXT)
      expect((await store.get(c.id))?.pause).toBeUndefined()
    })

    it('the safety cap counts Codex responses: blocks of one response are one round, and the third round stops the run with no stopped notice', async () => {
      svc = paused()
      const c = await store.create('cx', dir)
      await pausing(c.id)
      const { p, reached } = hang(c.id, [
        { kind: 'init', sessionId: 'th-1' },
        // One response's three parallel calls, all blocked: one round.
        ...blockedRow('b1', 'th-1:response-0'),
        ...blockedRow('b2', 'th-1:response-0'),
        ...blockedRow('b3', 'th-1:response-0'),
        ...blockedRow('b4', 'th-1:response-1')
      ])
      await reached
      await tick()
      expect(svc.isRunning(c.id)).toBe(true) // two rounds so far
      for (const e of blockedRow('b5', 'th-1:response-2')) emit(e)
      await p
      expect(kinds(await itemsOf(c.id))).toEqual(['user', 'tool', 'tool', 'tool', 'tool', 'tool', 'notice:userPaused'])
      expect(await store.get(c.id)).toMatchObject({ pause: 'paused', inFlight: false })
      expect(ends).toEqual([{ chatId: c.id, agent: 'cx', outcome: 'ok', reply: expect.any(String) }])
    })

    it('hooks codex never trusts: the pause hook goes with the vault hooks, fresh too, then neither; a pause asked in that hookless run still lands at its end', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        svc = paused({ onIdle: (id) => queue.idle(id) })
        const queue = queueOf(svc)
        const c = await store.create('cx', dir)
        scripts.push({ outcome: { hooksUntrusted: true, result: null } }, { outcome: { hooksUntrusted: true, result: null } })
        const { p, reached, script } = hang(c.id, [{ kind: 'init', sessionId: 'th-1' }])
        await reached
        expect(codexCalls.map(shape)).toEqual([
          { hooks: [...VAULT, PAUSE_HOOK], fresh: false, key: true, flag: tmp.pauseFlagOf(c.id) },
          { hooks: [...VAULT, PAUSE_HOOK], fresh: true, key: true, flag: tmp.pauseFlagOf(c.id) },
          { hooks: null, fresh: false, key: false, flag: tmp.pauseFlagOf(c.id) }
        ])
        // Shown while the hookless run is still going, so a pause asked now is not a surprise.
        const shown = pushes
          .flatMap((x) => (x.chatId === c.id && x.kind === 'items' ? x.items : []))
          .filter((i) => i.type === 'notice' && i.kind === 'unguarded')
        expect(shown.at(-1)).toMatchObject({ text: NOTICE_TEXT.unguarded })
        // Nothing blocks this run's calls, so the reply runs to its end; the pause is not refused, and lands there.
        await queue.pause(c.id)
        emit({ kind: 'toolUse', id: 'c1', name: 'Bash', input: { command: 'ls' }, message: 'th-1:response-0' })
        emit({ kind: 'toolResult', toolUseId: 'c1', content: 'a b', isError: false })
        emit({ kind: 'assistantText', text: 'done' })
        emit({ ...okResult, sessionId: 'th-1' })
        script.end!()
        await p
        expect(kinds(await itemsOf(c.id))).toEqual(['user', 'notice:unguarded', 'tool', 'assistant', 'notice:userPaused'])
        expect(await store.get(c.id)).toMatchObject({ pause: 'paused', held: true, inFlight: false })
        expect(existsSync(tmp.pauseFlagOf(c.id))).toBe(false)
        const lines = log.mock.calls.map((a) => a.map(String).join(' '))
        expect(lines.filter((l) => /codex hooks not confirmed/i.test(l))).toHaveLength(1)
      } finally {
        log.mockRestore()
      }
    })

    it('a Codex chat without the hook entry is refused with PAUSE_UNAVAILABLE, as a Claude chat is', async () => {
      svc = withCodex({ tmp: new ChatTmp(join(dir, 'claude-tmp')) })
      const queue = queueOf(svc)
      const c = await store.create('cx', dir)
      const { p, reached, script } = hang(c.id, [{ kind: 'init', sessionId: 'th-1' }])
      await reached
      await expect(queue.pause(c.id)).rejects.toThrow(PAUSE_UNAVAILABLE)
      expect((await store.get(c.id))?.pause).toBeUndefined()
      script.end!()
      await p
    })

    it("a Codex chat's Pause needs the Codex hook itself: with only Claude's, or with the pause cap off, it is refused while a Claude chat still pauses", async () => {
      const h = await store.create('helper', dir)
      const c = await store.create('cx', dir)
      for (const extra of [
        { codexPauseHook: undefined },
        { caps: (e: Engine) => ({ ...engineCaps(e), ...(e === 'codex' ? { pause: false } : {}) }) }
      ] as Partial<ChatServiceDeps>[]) {
        svc = paused(extra)
        expect(await svc.canPause(c.id)).toBe(false)
        expect(await svc.canPause(h.id)).toBe(true)
        const queue = queueOf(svc)
        const { p, reached, script } = hang(c.id, [{ kind: 'init', sessionId: 'th-1' }])
        await reached
        await expect(queue.pause(c.id)).rejects.toThrow(PAUSE_UNAVAILABLE)
        expect((await store.get(c.id))?.pause).toBeUndefined()
        expect(existsSync(tmp.pauseFlagOf(c.id))).toBe(false)
        script.end!()
        await p
      }
      // With both hooks the same server takes either chat's Pause.
      svc = paused()
      expect(await svc.canPause(c.id)).toBe(true)
      expect(await svc.canPause(h.id)).toBe(true)
    })

    describe('against the fake codex', () => {
      const fake = fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url))
      const jsonl = (p: string) =>
        existsSync(p)
          ? readFileSync(p, 'utf8')
              .split('\n')
              .filter(Boolean)
              .map((l) => JSON.parse(l))
          : []
      const notice = (method: string, type: string, id: string) => ({
        notify: {
          method,
          params: { threadId: '$THREAD', turnId: '$TURN', item: { type, id, ...(type === 'agentMessage' ? { text: id } : {}) } }
        }
      })

      // The fake behind the real runner, as app.ts wires it, with the real vault and pause hook commands; `play` writes the
      // script the next turn plays, so a later turn (Resume) can play another one.
      const fakeSetup = () => {
        const bin = writeFakeBin(dir, 'codex-shim', fake)
        const script = join(dir, 'codex-script.jsonl')
        const play = (steps: unknown[]) => writeFileSync(script, steps.map((x) => JSON.stringify(x)).join('\n') + '\n')
        const home = join(dir, 'codex-home')
        mkdirSync(join(home, 'threads'), { recursive: true })
        const log = join(dir, 'codex-log.jsonl'),
          hooksOut = join(dir, 'hooks-out.jsonl')
        const vault = codexVaultHooks({
          keyFile: join(dir, 'cfg', 'zumibot-vault', 'vault.key'),
          vaultFile: join(dir, 'data', 'vault.json'),
          home: join(dir, 'home')
        })
        svc = paused({
          codexVaultHooks: vault,
          onIdle: (id) => queue.idle(id),
          codex: {
            locate: async () => bin,
            // As app.ts does: the base env under the run's own and under the pre-flight's.
            run: (o) => {
              codexCalls.push(o)
              const base = {
                ...process.env,
                FAKE_CODEX_HOME: home,
                FAKE_CODEX_SCRIPT: script,
                FAKE_CODEX_LOG: log,
                FAKE_CODEX_HOOKS_OUT: hooksOut
              }
              return runCodex({
                ...o,
                env: { ...base, ...o.env },
                ...(o.hookTrustEnv ? { hookTrustEnv: { ...base, ...o.hookTrustEnv } } : {})
              })
            },
            definitionOf: async () => ({ ...DEF })
          }
        })
        const queue = queueOf(svc)
        return { play, log, hooksOut, queue }
      }
      // A main-thread token update, which codex sends once per model request after that request's hooks (probe check 11).
      const usage = {
        notify: {
          method: 'thread/tokenUsage/updated',
          params: {
            threadId: '$THREAD',
            turnId: '$TURN',
            tokenUsage: {
              total: { totalTokens: 11, inputTokens: 10, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 },
              last: { totalTokens: 11, inputTokens: 10, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 },
              modelContextWindow: 258400
            }
          }
        }
      }

      it('the real hook blocks main calls while the flag exists and lets a subagent call through; the third blocked response ends the run with turn/interrupt, it lands paused, and Resume continues the thread', async () => {
        const { play, log, hooksOut, queue } = fakeSetup()
        play([
          notice('item/started', 'reasoning', 'rs_1'),
          { exec: { command: 'touch one', id: 'exec-1' } },
          { exec: { command: 'touch two', id: 'exec-2' } },
          // A subagent's call (agent_id in its hook input) runs while the main thread is paused.
          { exec: { command: 'echo sub', id: 'exec-sub', output: 'sub\n', agent: { threadId: 'child-thread' } } },
          notice('item/started', 'agentMessage', 'msg_2'),
          { exec: { command: 'touch three', id: 'exec-3' } },
          notice('item/started', 'reasoning', 'rs_3'),
          { exec: { command: 'touch four', id: 'exec-4' } },
          notice('item/started', 'reasoning', 'rs_4'),
          { sleep: 5000 },
          notice('item/completed', 'agentMessage', 'not reached')
        ])
        const c = await store.create('cx', dir)
        await pausing(c.id)
        await svc.send(c.id, 'go')
        // Hook level: every main call blocked, the subagent's passed.
        expect(jsonl(hooksOut).map((h) => [h.id, h.agentId ?? null, h.blocked])).toEqual([
          ['exec-1', null, true],
          ['exec-2', null, true],
          ['exec-sub', 'child-thread', false],
          ['exec-3', null, true],
          ['exec-4', null, true]
        ])
        expect(jsonl(log).map((l) => l.method)).toContain('turn/interrupt')
        const items = await itemsOf(c.id)
        const tools = items.filter((i): i is Extract<ChatItem, { type: 'tool' }> => i.type === 'tool')
        expect(tools.filter((t) => t.name === CODEX_BLOCKED_TOOL).map((t) => [t.id, t.result, t.isError])).toEqual(
          ['exec-1', 'exec-2', 'exec-3', 'exec-4'].map((id) => [id, PAUSE_BLOCK_TEXT, true])
        )
        expect(items.some((i) => i.type === 'assistant')).toBe(false)
        expect(kinds(items).at(-1)).toBe('notice:userPaused')
        expect(kinds(items)).not.toContain('notice:stopped')
        const thread = (await store.get(c.id))?.sessionId
        expect(await store.get(c.id)).toMatchObject({ pause: 'paused', inFlight: false, sessionEngine: 'codex' })
        expect(existsSync(tmp.pauseFlagOf(c.id))).toBe(false)
        expect(ends).toEqual([{ chatId: c.id, agent: 'cx', outcome: 'ok', reply: expect.any(String) }])
        // Resume: Continue on the same thread, in a new process, whose calls the hook lets through (no flag now).
        play([{ exec: { command: 'touch five', id: 'exec-5' } }, notice('item/completed', 'agentMessage', 'resumed')])
        await queue.resumePaused(c.id)
        const resumed = jsonl(log)
          .filter((l) => l.method === 'thread/resume' || l.method === 'turn/start')
          .slice(-2)
        expect(resumed.map((l) => [l.method, l.params.threadId])).toEqual([
          ['thread/resume', thread],
          ['turn/start', thread]
        ])
        expect(JSON.stringify(resumed[1].params.input)).toContain(JSON.stringify(RESUME_TEXT))
        expect(jsonl(hooksOut).at(-1)).toMatchObject({ id: 'exec-5', blocked: false })
        expect((await itemsOf(c.id)).at(-1)).toMatchObject({ type: 'assistant', text: 'resumed' })
        expect((await store.get(c.id))?.pause).toBeUndefined()
      }, 30_000)

      it('requests of a blocked call alone, with only token usage between them (no reasoning, no message), still count as rounds: the third stops the run', async () => {
        const { play, log, hooksOut } = fakeSetup()
        play([
          // One request of two parallel calls: one round.
          { exec: { command: 'touch one', id: 'exec-1' } },
          { exec: { command: 'touch one-b', id: 'exec-1b' } },
          usage,
          { exec: { command: 'touch two', id: 'exec-2' } },
          usage,
          { exec: { command: 'touch three', id: 'exec-3' } },
          usage,
          { sleep: 5000 },
          notice('item/completed', 'agentMessage', 'not reached')
        ])
        const c = await store.create('cx', dir)
        await pausing(c.id)
        await svc.send(c.id, 'go')
        // Every call reached the hook and was blocked: the cap waited for the third request, not the third call.
        expect(jsonl(hooksOut).map((h) => [h.id, h.blocked])).toEqual([
          ['exec-1', true],
          ['exec-1b', true],
          ['exec-2', true],
          ['exec-3', true]
        ])
        expect(jsonl(log).map((l) => l.method)).toContain('turn/interrupt')
        const items = await itemsOf(c.id)
        expect(items.filter((i) => i.type === 'tool').map((t) => [t.id, (t as Extract<ChatItem, { type: 'tool' }>).name])).toEqual(
          ['exec-1', 'exec-1b', 'exec-2', 'exec-3'].map((id) => [id, CODEX_BLOCKED_TOOL])
        )
        expect(items.some((i) => i.type === 'assistant')).toBe(false)
        expect(kinds(items)).not.toContain('notice:stopped')
        expect(kinds(items).at(-1)).toBe('notice:userPaused')
        expect(await store.get(c.id)).toMatchObject({ pause: 'paused', inFlight: false })
        expect(ends).toEqual([{ chatId: c.id, agent: 'cx', outcome: 'ok', reply: expect.any(String) }])
      }, 30_000)
    })
  })

  // Probe check 13 behind the real runner and the fake (R21, R22, R7): a Codex subagent in the Dispatched agents panel,
  // the Files panel and the cards, stopped with its process, and finishing under a pause.
  describe('subagents', () => {
    const fake = fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url))
    const PAUSE_ENTRY = fileURLToPath(new URL('../fixtures/pause-hook-src.mjs', import.meta.url))
    const PAUSE_HOOK = codexPauseHook({ node: process.execPath, pauseHookEntry: PAUSE_ENTRY, electronNode: false })!
    const jsonl = (p: string) =>
      existsSync(p)
        ? readFileSync(p, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : []
    const kid = (item: Record<string, unknown>, method = 'item/completed') => ({
      notify: { method, params: { threadId: 'kid', turnId: 'kid-turn', item } }
    })
    const said = (text: string) => ({
      notify: {
        method: 'item/completed',
        params: { threadId: '$THREAD', turnId: '$TURN', item: { type: 'agentMessage', id: `m-${text.length}`, text } }
      }
    })
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    const until = async (check: () => boolean | Promise<boolean>, ms = 10_000) => {
      for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (await check()) return
      throw new Error('timed out waiting')
    }
    const tools = (items: ChatItem[]) => items.filter((i): i is Extract<ChatItem, { type: 'tool' }> => i.type === 'tool')
    let dispatch: DispatchService
    let snaps: SnapshotStore
    let tmp: ChatTmp
    beforeEach(() => {
      dispatch = new DispatchService({ store, onChanged: () => {}, now: () => 5000, privateTool: () => null, delayMs: 5 })
      // As app.ts wires it: every saved item list tells the service which Agent rows are visible.
      store.setItemsListener((id, items) => dispatch.noteItems(id, items))
      snaps = new SnapshotStore(join(dir, 'snap'))
      tmp = new ChatTmp(join(dir, 'claude-tmp'))
    })
    afterEach(() => {
      store.setItemsListener(null)
    })

    // The fake behind the real runner, as app.ts wires it; the shim appends each process's argv, then `---`.
    const setup = (extra: Partial<ChatServiceDeps> = {}) => {
      const argvOut = join(dir, 'codex-argv.txt')
      const bin = writePreludeBin(
        dir,
        'codex-shim',
        `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(argvOut)}, process.argv.slice(2).map((a) => a + '\\n').join('') + '---\\n')`,
        fake
      )
      const script = join(dir, 'codex-script.jsonl')
      const play = (steps: unknown[]) => writeFileSync(script, steps.map((x) => JSON.stringify(x)).join('\n') + '\n')
      const home = join(dir, 'codex-home')
      mkdirSync(join(home, 'threads'), { recursive: true })
      const log = join(dir, 'codex-log.jsonl'),
        answers = join(dir, 'codex-answers.jsonl'),
        hooksOut = join(dir, 'hooks-out.jsonl'),
        pids = join(dir, 'pids.jsonl')
      svc = withCodex({
        dispatch,
        snapshots: snaps,
        readFile: async (p) => fs.readFile(p),
        tmp,
        onIdle: (id) => queue.idle(id),
        codex: {
          locate: async () => bin,
          run: (o) => {
            codexCalls.push(o)
            const base = {
              ...process.env,
              FAKE_CODEX_HOME: home,
              FAKE_CODEX_SCRIPT: script,
              FAKE_CODEX_LOG: log,
              FAKE_CODEX_ANSWERS: answers,
              FAKE_CODEX_HOOKS_OUT: hooksOut,
              FAKE_CODEX_PIDS: pids
            }
            return runCodex({
              ...o,
              env: { ...base, ...o.env },
              ...(o.hookTrustEnv ? { hookTrustEnv: { ...base, ...o.hookTrustEnv } } : {})
            })
          },
          definitionOf: async () => ({ ...DEF })
        },
        ...extra
      })
      const queue = new TaskQueue({
        store,
        chats: svc,
        groups: { send: async () => {}, rerun: async () => {}, compact: async () => {}, requestPause: () => false, resume: async () => {} },
        files: { commit: async () => [], removeFiles: async () => {} },
        push: () => {},
        now: () => 5000,
        newId: () => `q${++n}`
      })
      const argv = () =>
        existsSync(argvOut)
          ? readFileSync(argvOut, 'utf8')
              .split('---\n')
              .filter(Boolean)
              .map((c) => c.split('\n').filter(Boolean))
          : []
      return { play, log, answers, hooksOut, pids, argv, queue }
    }
    const methods = (log: string) => jsonl(log).map((l) => l.method)
    const pendingCard = () => {
      for (const p of [...pushes].reverse()) {
        if (p.kind !== 'items') continue
        const card = p.items.find((i) => i.type === 'approval' && i.status === 'pending')
        if (card) return card as Extract<ChatItem, { type: 'approval' }>
      }
      return null
    }

    it('a main Codex run asks for subagents while the dispatch cap is on; a Compact never does, nor any run with the cap off', async () => {
      const c = await store.create('cx', dir)
      await svc.send(c.id, 'one')
      expect(codexCalls[0].subagents).toBe(true)
      scripts.push({
        events: [{ kind: 'compacting', on: true }, { kind: 'init', sessionId: 's1' }, { kind: 'compacting', on: false }, okResult]
      })
      await svc.compact(c.id, '')
      expect(codexCalls[1].action).toEqual({ kind: 'compact' })
      expect(codexCalls[1].subagents).toBeUndefined()
      svc = withCodex({ caps: (e) => ({ ...engineCaps(e), ...(e === 'codex' ? { dispatch: false } : {}) }) })
      await svc.send(c.id, 'two')
      expect(codexCalls[2].subagents).toBeUndefined()
    })

    it("a spawned child is one dispatch entry with its steps and report; its card names it and is answered by id; its patch is in the Files panel under its name; its tokens are in the turn's cost", async () => {
      const costs: RunCostEvent[] = []
      const { play, answers, argv } = setup({ onRunCost: (e) => costs.push(e) })
      const spent = (threadId: string, input: number, cached: number, output: number) => ({
        notify: {
          method: 'thread/tokenUsage/updated',
          params: {
            threadId,
            turnId: 't',
            tokenUsage: {
              total: {
                totalTokens: input + output,
                inputTokens: input,
                cachedInputTokens: cached,
                outputTokens: output,
                reasoningOutputTokens: 0
              },
              last: {
                totalTokens: input + output,
                inputTokens: input,
                cachedInputTokens: cached,
                outputTokens: output,
                reasoningOutputTokens: 0
              },
              modelContextWindow: 258400
            }
          }
        }
      })
      const made = join(dir, 'made.txt')
      const change = { path: made, kind: { type: 'add' }, diff: 'made by helper\n' }
      play([
        said('Starting a helper.'),
        { spawn: { name: 'helper', threadId: 'kid', id: 'call_sp' } },
        { collab: { tool: 'wait', id: 'call_w' } },
        kid({ type: 'agentMessage', id: 'km1', text: 'Writing the file.' }),
        kid({ type: 'fileChange', id: 'patch-1', status: 'inProgress', changes: [change] }, 'item/started'),
        {
          request: {
            method: 'item/fileChange/requestApproval',
            params: { threadId: 'kid', turnId: 'kid-turn', itemId: 'patch-1', reason: null, grantRoot: null }
          }
        },
        kid({ type: 'fileChange', id: 'patch-1', status: 'completed', changes: [change] }),
        { exec: { command: 'cat made.txt', id: 'exec-kid', output: 'made by helper\n', agent: { threadId: 'kid' } } },
        kid({ type: 'agentMessage', id: 'km2', text: 'Made made.txt.' }),
        spent('kid', 3000, 1000, 200),
        { childEnd: { threadId: 'kid' } },
        { collab: { tool: 'wait', id: 'call_w', status: 'completed' } },
        spent('$THREAD', 1000, 500, 50),
        said('The helper made made.txt.')
      ])
      const c = await store.create('cx', dir)
      const sending = svc.send(c.id, 'go')
      await until(() => pendingCard() !== null)
      const card = pendingCard()!
      expect(card).toMatchObject({ toolName: 'ApplyPatch', description: 'From subagent helper', toolUseId: 'patch-1' })
      expect((card.input as any).changes).toEqual([{ path: made, kind: 'add', diff: 'made by helper\n' }])
      svc.answer(c.id, card.id, 'allow-once')
      await sending
      // The fake got the answer under its own id (the tag is the runner's), and multi_agent was on.
      expect(jsonl(answers)).toEqual([{ id: 0, result: { decision: 'accept' } }])
      expect(argv()[0]).toEqual(expect.arrayContaining(['--enable', 'multi_agent']))
      expect(argv()[0]).not.toContain('--disable')
      // The panel: one entry, done, with the child's steps and its last message as the report.
      expect((await dispatch.list(c.id)).map((s) => [s.id, s.status, s.parent, s.description, s.subagentType])).toEqual([
        ['call_sp', 'done', null, 'helper', 'codex']
      ])
      const got = (await dispatch.get(c.id, 'call_sp'))!.entry
      expect(got.report).toBe('Made made.txt.')
      expect(
        got.steps.map((s) => (s.kind === 'text' ? `text ${s.text}` : s.kind === 'tool' ? `tool ${s.name} ${s.id} ${s.result}` : s.kind))
      ).toEqual([
        'text Writing the file.',
        `tool ApplyPatch patch-1 add ${made}`,
        'tool Bash exec-kid made by helper\n',
        'text Made made.txt.'
      ])
      // The chat: the main thread's text and rows only; the card answered; the Agent row's result is the report.
      const items = await itemsOf(c.id)
      expect(items.filter((i) => i.type === 'assistant').map((i) => (i as Extract<ChatItem, { type: 'assistant' }>).text)).toEqual([
        'Starting a helper.',
        'The helper made made.txt.'
      ])
      expect(tools(items).map((t) => [t.name, t.id, t.result])).toEqual([
        ['Agent', 'call_sp', 'Made made.txt.'],
        ['Subagents', 'call_w', '']
      ])
      expect(items.find((i) => i.type === 'approval')).toMatchObject({ status: 'allowed-once', description: 'From subagent helper' })
      // The Files panel lists the child's new file under the Agent row, labelled with the subagent.
      const agentRow = tools(items).find((t) => t.name === 'Agent')!
      expect(agentRow.changes).toEqual([expect.objectContaining({ id: 'patch-1:0', path: made, op: 'create', subagent: 'helper' })])
      expect(await snaps.read(c.id, agentRow.changes![0].after!)).toBe('made by helper\n')
      const listed = listChatFiles(items, dir, os.homedir())
      expect(listed.changed.map((f) => [f.path, f.changes.map((s) => s.subagent)])).toEqual([[made, ['helper']]])
      // The turn's recorded cost holds the child's requests beside the main thread's (the fake's model is unpriced); the context does not.
      expect(costs.map((c) => c.cost.models)).toEqual([
        { 'fake-model': { input: 2500, cacheRead: 1500, cacheWrite: 0, output: 250, costUsd: null } }
      ])
      expect((await store.get(c.id))?.context?.used).toBe(1050)
    }, 30_000)

    it("Stop during a child's command ends the codex process and with it the child: the entry ends stopped and nothing keeps running", async () => {
      const { play, log, pids } = setup()
      play([
        { spawn: { name: 'sleeper', threadId: 'kid', id: 'call_sp' } },
        { collab: { tool: 'wait', id: 'call_w' } },
        { exec: { command: 'sleep 60', id: 'exec-sleep', hold: 60_000, agent: { threadId: 'kid' } } },
        said('not reached')
      ])
      const c = await store.create('cx', dir)
      const sending = svc.send(c.id, 'go')
      await until(() => jsonl(pids).some((p) => p.role === 'exec'))
      expect((await dispatch.list(c.id)).map((s) => [s.id, s.status])).toEqual([['call_sp', 'running']])
      const procs = jsonl(pids)
      for (const p of procs) expect(alive(p.pid)).toBe(true)
      svc.stop(c.id)
      await sending
      // turn/interrupt alone leaves a child running (check 13); the process ending at the turn's end is what stops it.
      expect(methods(log)).toContain('turn/interrupt')
      await until(() => procs.every((p) => !alive(p.pid)), 8000)
      expect((await dispatch.list(c.id)).map((s) => [s.id, s.status])).toEqual([['call_sp', 'stopped']])
      expect((await itemsOf(c.id)).some((i) => i.type === 'assistant')).toBe(false)
      // The agent is told at its next turn that the subagent was lost.
      expect((await store.get(c.id))?.lost).toEqual(['sleeper'])
    }, 30_000)

    it("a child the main turn ends without waiting for is cut off with the process: codex sends no end for it, so the turn's end closes its entry", async () => {
      const { play, pids } = setup()
      play([{ spawn: { name: 'straggler', threadId: 'kid', id: 'call_sp' } }, said('Done without waiting.')])
      const c = await store.create('cx', dir)
      await svc.send(c.id, 'go')
      expect((await dispatch.list(c.id)).map((s) => [s.id, s.status])).toEqual([['call_sp', 'interrupted']])
      expect(tools(await itemsOf(c.id)).map((t) => [t.name, t.result])).toEqual([['Agent', null]])
      await until(() => jsonl(pids).every((p) => !alive(p.pid)), 8000)
      // Not a Stop: nothing to tell the agent next turn.
      expect((await store.get(c.id))?.lost).toBeUndefined()
    }, 30_000)

    it('R2: a pause blocks the main thread while the child works on and its wait passes; the child finishes and the pause lands at the turn end', async () => {
      const { play, log, hooksOut, queue } = setup({
        codexPauseHook: PAUSE_HOOK,
        pauseHook: { settings: pauseSettings({ node: '/opt/node', entry: '/opt/pauseHook.mjs', electronNode: false }) }
      })
      const c = await store.create('cx', dir)
      play([
        { spawn: { name: 'worker', threadId: 'kid', id: 'call_sp' } },
        // The pause is asked while the child runs.
        { until: { file: tmp.pauseFlagOf(c.id) } },
        { exec: { command: 'touch main-file', id: 'exec-main' } },
        { exec: { command: 'echo sub', id: 'exec-sub', output: 'sub\n', agent: { threadId: 'kid' } } },
        { collab: { tool: 'wait', id: 'call_w' } },
        kid({ type: 'agentMessage', id: 'km', text: 'sub done' }),
        { childEnd: { threadId: 'kid' } },
        { collab: { tool: 'wait', id: 'call_w', status: 'completed' } },
        said('Paused once the worker finished; next I touch main-file.')
      ])
      const sending = svc.send(c.id, 'go')
      await until(async () => (await dispatch.list(c.id)).some((s) => s.status === 'running'))
      await queue.pause(c.id)
      await sending
      // Hook level: the spawn ran before the pause; then the main call was blocked, the child's call and the main wait passed.
      expect(jsonl(hooksOut).map((h) => [h.id, h.tool, h.agentId, h.blocked])).toEqual([
        ['call_sp', 'collaborationspawn_agent', null, false],
        ['exec-main', 'Bash', null, true],
        ['exec-sub', 'Bash', 'kid', false],
        ['call_w', 'collaborationwait_agent', null, false]
      ])
      // One blocked response is under the cap: the run ended by itself, with no interrupt.
      expect(methods(log)).not.toContain('turn/interrupt')
      expect((await dispatch.list(c.id)).map((s) => [s.id, s.status])).toEqual([['call_sp', 'done']])
      expect((await dispatch.get(c.id, 'call_sp'))!.entry.report).toBe('sub done')
      const items = await itemsOf(c.id)
      expect(tools(items).map((t) => [t.name, t.id])).toEqual([
        ['Agent', 'call_sp'],
        [CODEX_BLOCKED_TOOL, 'exec-main'],
        ['Subagents', 'call_w']
      ])
      expect(tools(items)[1]).toMatchObject({ result: PAUSE_BLOCK_TEXT, isError: true })
      expect(kinds(items)).not.toContain('notice:stopped')
      expect(kinds(items).slice(-2)).toEqual(['assistant', 'notice:userPaused'])
      expect(await store.get(c.id)).toMatchObject({ pause: 'paused', inFlight: false })
      expect(existsSync(tmp.pauseFlagOf(c.id))).toBe(false)
    }, 30_000)

    it.each(['pause', 'stop'])(
      'a restarted child remains protected during %s and Stop records its lost work',
      async (action) => {
        const { play, log, hooksOut, queue } = setup({
          codexPauseHook: PAUSE_HOOK,
          pauseHook: { settings: pauseSettings({ node: '/opt/node', entry: '/opt/pauseHook.mjs', electronNode: false }) }
        })
        const c = await store.create('cx', dir)
        const secondTurn = { notify: { method: 'turn/started', params: { threadId: 'kid', turn: { id: 'kid-turn-two' } } } }
        play([
          { spawn: { name: 'worker', threadId: 'kid', id: 'call_sp' } },
          kid({ type: 'agentMessage', id: 'first-report', text: 'first report' }),
          { childEnd: { threadId: 'kid' } },
          secondTurn,
          {
            notify: {
              method: 'item/started',
              params: {
                threadId: 'kid',
                turnId: 'kid-turn-two',
                item: { type: 'commandExecution', id: 'second-command', command: 'echo second', status: 'inProgress' }
              }
            }
          },
          { until: { file: action === 'pause' ? tmp.pauseFlagOf(c.id) : join(dir, 'never') } },
          // Token updates separate the three blocked main responses, reaching Pause's safety cap.
          ...[1, 2, 3].flatMap((i) => [
            { exec: { command: `echo blocked-${i}`, id: `blocked-${i}` } },
            {
              notify: {
                method: 'thread/tokenUsage/updated',
                params: { threadId: '$THREAD', tokenUsage: { last: { inputTokens: 1 }, total: { totalTokens: i } } }
              }
            }
          ]),
          {
            notify: {
              method: 'item/completed',
              params: {
                threadId: 'kid',
                turnId: 'kid-turn-two',
                item: { type: 'agentMessage', id: 'second-report', text: 'second report' }
              }
            }
          },
          {
            notify: {
              method: 'item/started',
              params: {
                threadId: '$THREAD',
                item: { type: 'subAgentActivity', kind: 'completed', id: 'subagent-completed-kid-turn-two', agentThreadId: 'kid' }
              }
            }
          },
          said('child finished safely')
        ])
        const sending = svc.send(c.id, 'go')
        try {
          await until(
            async () =>
              (await dispatch.get(c.id, 'call_sp'))?.entry.steps.some((s) => s.kind === 'tool' && s.id === 'second-command') === true
          )
          expect((await dispatch.get(c.id, 'call_sp'))!.entry).toMatchObject({ status: 'running', report: null })
          if (action === 'pause') {
            await queue.pause(c.id)
            await sending
            expect(
              jsonl(hooksOut)
                .filter((h) => h.id.startsWith('blocked-'))
                .map((h) => h.blocked)
            ).toEqual([true, true, true])
            expect(methods(log)).not.toContain('turn/interrupt')
            expect((await dispatch.get(c.id, 'call_sp'))!.entry).toMatchObject({ status: 'done', report: 'second report' })
            expect(await store.get(c.id)).toMatchObject({ pause: 'paused', inFlight: false })
          } else {
            svc.stop(c.id)
            await sending
            expect((await store.get(c.id))?.lost).toEqual(['worker'])
            expect((await dispatch.get(c.id, 'call_sp'))!.entry.status).toBe('stopped')
          }
        } finally {
          svc.stop(c.id)
          await sending
        }
      },
      30_000
    )

    it('with the dispatch cap off the process keeps multi_agent disabled and the thread keeps its switch', async () => {
      const { play, log, argv } = setup({ caps: (e) => ({ ...engineCaps(e), ...(e === 'codex' ? { dispatch: false } : {}) }) })
      play([said('no subagents here')])
      const c = await store.create('cx', dir)
      await svc.send(c.id, 'go')
      expect(argv()[0]).toEqual(expect.arrayContaining(['--disable', 'multi_agent']))
      expect(argv()[0]).not.toContain('--enable multi_agent')
      expect(argv()[0].join(' ')).not.toContain('--enable multi_agent')
      const start = jsonl(log).find((l) => l.method === 'thread/start')!
      expect(start.params.config['features.multi_agent']).toBe(false)
    }, 30_000)
  })
})

describe('agent isolation', () => {
  const SBX = JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true }, permissions: { ask: ['WebFetch'] } })
  const GUARD = vaultGuardSettings({
    keyFile: '/home/u/.config/zumibot-vault/vault.key',
    vaultFile: '/home/u/.local/share/zumibot/vault.json',
    home: '/home/u'
  })
  const pauseJson = pauseSettings({ node: '/opt/node', entry: '/opt/pauseHook.mjs', electronNode: false })
  type Iso = NonNullable<ChatServiceDeps['isolation']>
  const iso = (run: Awaited<ReturnType<Iso['runFor']>>, seen: unknown[] = []): Iso => ({
    levelOf: () => (run.level === 'off' ? 'off' : 'sandbox'),
    runFor: async (agent, place) => {
      seen.push({ agent, ...place })
      return run
    }
  })
  const settingsOf = (args: string[]) => {
    expect(args.filter((a) => a === '--settings')).toHaveLength(1)
    return JSON.parse(args[args.indexOf('--settings') + 1]) as {
      sandbox?: { enabled?: boolean }
      permissions?: { deny?: string[]; ask?: string[] }
      hooks?: { PreToolUse?: { matcher: string }[] }
    }
  }
  const fetchReq = (url: string): RunEvent => ({
    kind: 'permissionRequest',
    requestId: 'f1',
    toolName: 'WebFetch',
    input: { url, prompt: 'x' },
    description: null,
    reason: null,
    toolUseId: 'tf1'
  })

  it('an Off agent runs exactly as before', async () => {
    svc = makeService({ isolation: iso({ level: 'off' }) })
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'ping')
    expect(calls[0].args).not.toContain('--settings')
  })

  it("a sandboxed agent's main run gets the sandbox in the one --settings, beside the vault guard and the pause hook", async () => {
    const seen: unknown[] = []
    svc = makeService({
      isolation: iso({ level: 'sandbox', settings: SBX, network: [] }, seen),
      vaultGuard: GUARD,
      tmp: new ChatTmp(join(dir, 'claude-tmp')),
      pauseHook: { settings: pauseJson }
    })
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'ping')
    const merged = settingsOf(calls[0].args)
    expect(merged.sandbox?.enabled).toBe(true)
    expect(merged.permissions?.deny).toContain(KEY_DIR_RULE)
    expect(merged.hooks?.PreToolUse?.map((h) => h.matcher)).toEqual(['*', 'Bash'])
    expect(seen[0]).toMatchObject({ agent: 'helper', engine: 'claude', cwd: dir, tmpDir: expect.stringContaining('claude-tmp') })
    // A side run keeps its own guard (it runs no tools); a Compact runs none and gets no sandbox.
    expect(svc.sideBase(c.id, 'helper')!.args.extraArgs).not.toContain('--settings')
    await store.update(c.id, { sessionId: 's1' })
    await svc.compact(c.id, '')
    expect(calls[1].args).not.toContain('--settings')
  })

  it('a refused run never spawns and shows the reason as the chat error', async () => {
    svc = makeService({ isolation: iso({ level: 'sandbox', refused: 'The sandbox is not available here: no bwrap.' }) })
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'ping')
    expect(calls).toHaveLength(0)
    const err = (await itemsOf(c.id)).find((i) => i.type === 'error')
    expect(err).toMatchObject({ text: 'The sandbox is not available here: no bwrap.' })
  })

  it('auto mode: an on-list fetch runs without a card, an off-list one is refused with a line, never a card', async () => {
    svc = makeService({ isolation: iso({ level: 'sandbox', settings: SBX, network: ['*.example.com'] }) })
    scripts.push({
      events: [
        { kind: 'init', sessionId: 's1' },
        fetchReq('https://docs.example.com/a'),
        { ...fetchReq('https://evil.test/x'), requestId: 'f2', toolUseId: 'tf2' } as RunEvent,
        okResult
      ]
    })
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'go')
    const answers = sent.map((m) => JSON.stringify(m))
    expect(answers.find((a) => a.includes('"f1"'))).toContain('"allow"')
    const denied = answers.find((a) => a.includes('"f2"'))!
    expect(denied).toContain('"deny"')
    expect(denied).toContain('evil.test is not on this agent')
    expect((await itemsOf(c.id)).some((i) => i.type === 'approval')).toBe(false)
  })

  it('manual mode: an on-list fetch still gets its card (isolation never loosens approvals)', async () => {
    mode = 'manual'
    svc = makeService({ isolation: iso({ level: 'sandbox', settings: SBX, network: ['example.com'] }) })
    const script: Script = { events: [{ kind: 'init', sessionId: 's1' }, fetchReq('https://example.com/')], hang: true }
    scripts.push(script)
    const c = await store.create('helper', dir)
    const sending = svc.send(c.id, 'go')
    await vi.waitFor(async () => expect((await itemsOf(c.id)).some((i) => i.type === 'approval' && i.status === 'pending')).toBe(true))
    svc.answer(c.id, 'f1', 'deny')
    script.end?.()
    await sending
  })

  describe('container', () => {
    const fakeRun = (log: string[], denied: string[][] = []) => ({
      name: 'zumibot-x-1',
      wrap: (s: { bin: string; args: string[]; env: NodeJS.ProcessEnv }) => ({ bin: 'podman', args: ['run', ...s.args], env: s.env }),
      drainDenied: () => denied.shift() ?? [],
      dispose: async () => {
        log.push('dispose')
      }
    })
    const contained = (
      plan: { open(env: Record<string, string>): Promise<unknown> },
      extra: Partial<{ autoBash: boolean; webSearch: boolean; network: string[] }> = {}
    ): Iso => ({
      levelOf: () => 'container',
      runFor: async () =>
        ({ level: 'container', network: [], autoBash: false, webSearch: false, ...extra, plan }) as Awaited<ReturnType<Iso['runFor']>>
    })

    it('runs through the container, with its own --settings, and ends it with the attempt', async () => {
      const log: string[] = []
      const opened: Record<string, string>[] = []
      svc = makeService({
        isolation: contained({
          open: async (env) => {
            opened.push(env)
            return fakeRun(log)
          }
        }),
        tmp: new ChatTmp(join(dir, 'claude-tmp'))
      })
      const c = await store.create('helper', dir)
      await svc.send(c.id, 'ping')
      expect(calls).toHaveLength(1)
      expect(calls[0].wrap).toBeTypeOf('function')
      expect(calls[0].wrap!({ bin: 'claude', args: ['-p'], env: {} })).toMatchObject({ bin: 'podman', args: ['run', '-p'] })
      expect(settingsOf(calls[0].args).permissions).toMatchObject({ ask: ['WebFetch'], deny: ['WebSearch'] })
      expect(Object.keys(opened[0])).toContain('CLAUDE_CODE_TMPDIR')
      expect(log).toEqual(['dispose'])
    })

    it('an isolated agent gets no background-process tool: its processes would run on the host', async () => {
      const made: string[] = []
      const processTurns = {
        create: () => {
          made.push('proc')
          return {
            args: ['--mcp-config', '{"mcpServers":{"zumibot_processes":{}}}'],
            mcp: { name: 'zumibot_processes', command: 'n', args: [], passEnv: [], fixedEnv: {} },
            env: {},
            dispose: () => {}
          }
        }
      }
      svc = makeService({ isolation: contained({ open: async () => fakeRun([]) }), processTurns } as Partial<ChatServiceDeps>)
      const c = await store.create('helper', dir)
      await svc.send(c.id, 'ping')
      expect(made).toEqual([])
      expect(calls[0].args.join(' ')).not.toContain('zumibot_processes')
      svc = makeService({ isolation: iso({ level: 'off' }), processTurns } as Partial<ChatServiceDeps>)
      const d = await store.create('helper', dir)
      await svc.send(d.id, 'ping')
      expect(made).toEqual(['proc'])
    })

    it('the Bash choice is the only allow it adds; web search follows its switch', async () => {
      svc = makeService({ isolation: contained({ open: async () => fakeRun([]) }, { autoBash: true, webSearch: true }) })
      const c = await store.create('helper', dir)
      await svc.send(c.id, 'ping')
      expect(settingsOf(calls[0].args).permissions).toEqual({ ask: ['WebFetch'], allow: ['Bash'] })
    })

    it('a container that cannot open never spawns and shows why', async () => {
      svc = makeService({ isolation: contained({ open: async () => ({ refused: 'No: your home folder.' }) }) })
      const c = await store.create('helper', dir)
      await svc.send(c.id, 'ping')
      expect(calls).toHaveLength(0)
      expect((await itemsOf(c.id)).find((i) => i.type === 'error')).toMatchObject({ text: 'No: your home folder.' })
    })

    it("a host the network proxy refused during a tool shows on that tool's result", async () => {
      svc = makeService({ isolation: contained({ open: async () => fakeRun([], [['evil.test:443']]) }) })
      scripts.push({
        events: [
          { kind: 'init', sessionId: 's1' },
          { kind: 'toolUse', id: 't1', name: 'Bash', input: { command: 'curl https://evil.test' } } as RunEvent,
          { kind: 'toolResult', toolUseId: 't1', content: 'curl: (56) CONNECT tunnel failed, response 403', isError: true },
          okResult
        ]
      })
      const c = await store.create('helper', dir)
      await svc.send(c.id, 'go')
      const tool = (await itemsOf(c.id)).find((i) => i.type === 'tool') as { result?: { content?: string } } | undefined
      expect(JSON.stringify(tool)).toContain('deny network-outbound evil.test:443')
    })
  })
})

describe('ack line', () => {
  it("stores the line on the user's message while the turn runs, and only the agent's prompt reaches the CLI", async () => {
    const asked: { agent: string; text: string; todos: boolean }[] = []
    svc = makeService({
      acknowledge: async ({ agent, user, todos }) => {
        asked.push({ agent, text: user.text, todos })
        return 'Looking into it now.'
      }
    })
    scripts.push({ events: pong, act: async () => void (await tick()) })
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'what is due?')
    expect(asked).toEqual([{ agent: 'helper', text: 'what is due?', todos: false }])
    const items = await itemsOf(c.id)
    expect(items[0]).toMatchObject({ type: 'user', text: 'what is due?', ack: 'Looking into it now.' })
    expect(items.map((i) => i.type)).toEqual(['user', 'assistant'])
    expect(JSON.stringify(sent)).not.toContain('Looking into it now.')
    expect(
      pushes.some((p) => p.kind === 'items' && p.items.some((i) => i.type === 'user' && i.ack === 'Looking into it now.'))
    ).toBe(true)
  })

  it('drops a line that comes after the turn ended', async () => {
    let answer: (s: string) => void = () => {}
    svc = makeService({ acknowledge: () => new Promise((r) => (answer = r)) })
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'hi')
    answer('Too late.')
    await tick()
    expect((await itemsOf(c.id))[0]).not.toHaveProperty('ack')
  })

  it("is never asked for a routine's message, and a failure never reaches the turn", async () => {
    let asked = 0
    svc = makeService({
      acknowledge: async () => {
        asked++
        throw new Error('no claude')
      }
    })
    const c = await store.create('helper', dir)
    await svc.send(c.id, 'tick', [], undefined, undefined, undefined, undefined, true)
    expect(asked).toBe(0)
    await svc.send(c.id, 'typed')
    expect(asked).toBe(1)
    expect((await itemsOf(c.id)).map((i) => i.type)).toEqual(['user', 'assistant', 'user', 'assistant'])
  })
})
