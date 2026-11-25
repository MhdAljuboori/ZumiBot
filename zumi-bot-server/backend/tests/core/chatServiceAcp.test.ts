import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, promises as fs, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isolationRefusal, todoRefusal } from '@zumibot/shared/engine'
import { ChatStore } from '../../src/core/store/chatStore'
import { AttachmentStore } from '../../src/core/attachments/attachmentStore'
import { SnapshotStore } from '../../src/core/files/snapshotStore'
import { ChatService, MODEL_REFUSED, type ChatServiceDeps } from '../../src/core/chat/chatService'
import { startAcp, type AcpRunOptions } from '../../src/core/acp/acpRunner'
import { acpRecord, LaunchTrust } from '../../src/core/acp/launchTrust'
import { TODO_SYSTEM } from '../../src/core/todos/todoPrompt'
import { VAULT_SYSTEM } from '../../src/core/vault/vaultPrompt'
import { RUN_SYSTEM } from '../../src/core/processes/processPrompt'
import { NO_MCP } from '../../src/core/ipc/mcpSpec'
import { IsolationService } from '../../src/core/isolation/isolationService'
import { AuditService } from '../../src/core/audit/auditService'
import type { AuditRecord } from '@zumibot/shared/audit'
import { ACP_TEXT, type AcpLaunch } from '@zumibot/shared/acp'
import type { Provider } from '@zumibot/shared/engine'
import type { AgentRule, ChatItem, ChatPush } from '@zumibot/shared/types'

// ACP agents through ChatService, against the fake agent (fake-acp-agent.mjs) spawned by the real runner, as app.ts wires it:
// the base env under the run's own. See docs/architecture/protocol-engines.md.

const FAKE = fileURLToPath(new URL('../fixtures/fake-acp-agent.mjs', import.meta.url))
const BODY = 'You are the Gemini helper.'
const KEY = 'sk-fake-acp-key-0123456789'

let dir: string
let store: ChatStore
let files: AttachmentStore
let trust: LaunchTrust
let pushes: ChatPush[]
let acpCalls: AcpRunOptions[]
let n: number
let launch: AcpLaunch | null
let provider: Provider | null
let located: (command: string) => string | null
let script: Record<string, unknown>
let rules: {
  has(agent: string, key: string): boolean
  add(agent: string, rule: AgentRule): void
  cli(agent: string): string[]
  addCli(agent: string, rule: string): Promise<void>
  added: [string, AgentRule][]
}
let svc: ChatService
const claudeRun = vi.fn()

const logFile = () => join(dir, 'acp-log.jsonl')
const startFile = () => join(dir, 'acp-start.jsonl')
const lines = (p: string): any[] =>
  existsSync(p)
    ? readFileSync(p, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []
const methods = () =>
  lines(logFile())
    .filter((m) => typeof m.method === 'string')
    .map((m) => m.method as string)
// The fake's answers to its own requests, in order (a permission's selected option, an elicitation's action).
const answers = () =>
  lines(logFile())
    .filter((m) => m.method === undefined && m.result !== undefined)
    .map((m) => m.result)

// As app.ts does: the base env under the run's own.
const acpRun = (o: AcpRunOptions) => {
  acpCalls.push(o)
  writeFileSync(join(dir, 'acp-script.json'), JSON.stringify(script))
  const base = { ...process.env, FAKE_ACP_SCRIPT: join(dir, 'acp-script.json'), FAKE_ACP_LOG: logFile(), FAKE_ACP_START: startFile() }
  return startAcp({ ...o, env: { ...base, ...o.env }, killGraceMs: 200, killForceMs: 200 })
}

const makeService = (extra: Partial<ChatServiceDeps> = {}) =>
  new ChatService({
    store,
    files,
    locate: async () => '/bin/claude',
    run: (o) => {
      claudeRun(o)
      throw new Error('claude must not run for an ACP agent')
    },
    push: (p) => pushes.push(p),
    now: () => 1000 + n,
    newId: () => `x${++n}`,
    permissionMode: 'manual',
    disallowedToolsFor: () => [],
    agentRules: rules,
    engineOf: async (agent) => (agent === 'gem' ? 'acp' : 'claude'),
    acp: {
      definitionOf: async (agent) => (agent === 'gem' ? { provider, body: BODY, launch } : null),
      trust: (agent, l) => trust.check(agent, acpRecord(l)),
      locate: async (command) => located(command),
      run: acpRun
    },
    ...extra
  })

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-acp-svc-'))
  store = new ChatStore(dir)
  files = new AttachmentStore(join(dir, 'attachments'), () => 'unused')
  trust = new LaunchTrust(join(dir, 'data'))
  await trust.load()
  pushes = []
  acpCalls = []
  n = 0
  launch = { command: process.execPath, args: [FAKE], authEnv: [] }
  provider = 'acp'
  located = (command) => command
  script = { steps: [{ text: 'hello there' }] }
  claudeRun.mockClear()
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
  await trust.confirm('gem', acpRecord(launch))
  svc = makeService()
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const itemsOf = (id: string) => store.loadItems(id)
const kinds = (items: ChatItem[]) => items.map((i) => (i.type === 'notice' ? `notice:${i.kind}` : i.type))
const lastError = async (id: string) =>
  (await itemsOf(id)).filter((i): i is Extract<ChatItem, { type: 'error' }> => i.type === 'error').pop()
type Card = Extract<ChatItem, { type: 'approval' }>
// The newest pushed card of the chat, once one is pending.
const pendingCard = async (chatId: string): Promise<Card> => {
  let card: Card | undefined
  await vi.waitFor(
    () => {
      const p = [...pushes].reverse().find((x): x is Extract<ChatPush, { kind: 'items' }> => x.chatId === chatId && x.kind === 'items')
      card = p?.items.filter((i): i is Card => i.type === 'approval' && i.status === 'pending').pop()
      expect(card).toBeDefined()
    },
    { timeout: 10_000, interval: 20 }
  )
  return card!
}
const cards = async (chatId: string): Promise<Card[]> => (await itemsOf(chatId)).filter((i): i is Card => i.type === 'approval')

describe('ACP agents in ChatService', () => {
  it('a model picked by hand is refused for an ACP chat (no models cap), and nothing is stored', async () => {
    const c = await store.create('gem', dir)
    await expect(svc.setModel(c.id, 'opus')).rejects.toThrow(MODEL_REFUSED)
    await expect(svc.setModel(c.id, 'gpt-5')).rejects.toThrow(MODEL_REFUSED)
    expect((await store.get(c.id))?.model).toBeUndefined()
    // Putting it back on the agent's own model is always allowed.
    await svc.setModel(c.id, null)
  })

  it("a send runs the ACP agent (never claude) on its file's launch and body, and records the session as acp", async () => {
    const c = await store.create('gem', dir)
    await svc.send(c.id, 'hi')
    expect(claudeRun).not.toHaveBeenCalled()
    expect(acpCalls).toHaveLength(1)
    expect(acpCalls[0]).toMatchObject({
      bin: process.execPath,
      args: [FAKE],
      cwd: dir,
      start: { kind: 'new' },
      systemPrompt: `${BODY}\n\n${RUN_SYSTEM}`
    })
    expect(typeof acpCalls[0].requestTag).toBe('string')
    expect(methods()).toEqual(['initialize', 'session/new', 'session/prompt'])
    const items = await itemsOf(c.id)
    expect(kinds(items)).toEqual(['user', 'assistant'])
    expect(items[1]).toMatchObject({ type: 'assistant', text: 'hello there' })
    expect(await store.get(c.id)).toMatchObject({ sessionId: 'fake-session-1', sessionEngine: 'acp', inFlight: false })
    // No side questions for ACP: no base is kept.
    expect(svc.sideBase(c.id, 'gem')).toBeNull()
  }, 20_000)

  it('run paragraph reaches an ACP agent after its body, though it has no bridges', async () => {
    const c = await store.create('gem', dir)
    await svc.send(c.id, 'hi')
    expect(acpCalls[0].systemPrompt).toBe([BODY, RUN_SYSTEM].join('\n\n'))
  }, 20_000)

  it('the next send resumes the session through the agent (load), with the same instructions', async () => {
    script = { initialize: { agentCapabilities: { loadSession: true } }, sessions: ['fake-session-1'], steps: [{ text: 'again' }] }
    const c = await store.create('gem', dir)
    await svc.send(c.id, 'one')
    await svc.send(c.id, 'two')
    expect(acpCalls.map((o) => o.start)).toEqual([{ kind: 'new' }, { kind: 'resume', sessionId: 'fake-session-1' }])
    expect(methods()).toEqual(['initialize', 'session/new', 'session/prompt', 'initialize', 'session/load', 'session/prompt'])
    expect(acpCalls[1].systemPrompt).toBe(`${BODY}\n\n${RUN_SYSTEM}`)
    expect(kinds(await itemsOf(c.id))).toEqual(['user', 'assistant', 'user', 'assistant'])
  }, 20_000)

  it('a resume the agent cannot serve (missingSession) is followed by one reseed from the visible history', async () => {
    script = { initialize: { agentCapabilities: { loadSession: true } }, sessions: [], steps: [{ text: 'fresh' }] }
    const c = await store.create('gem', dir)
    await store.saveItems(c.id, [
      { type: 'user', id: 'u0', text: 'earlier question', ts: 1 },
      { type: 'assistant', id: 'a0', text: 'earlier answer', ts: 2 }
    ])
    await store.update(c.id, { sessionId: 'gone', sessionEngine: 'acp' })
    await svc.send(c.id, 'next')
    expect(acpCalls.map((o) => o.start)).toEqual([{ kind: 'resume', sessionId: 'gone' }, { kind: 'new' }])
    expect(methods()).toEqual(['initialize', 'session/load', 'initialize', 'session/new', 'session/prompt'])
    // The seed carries the visible history, and the expired notice says why.
    expect(JSON.stringify(acpCalls[1].prompt)).toContain('earlier answer')
    expect(kinds(await itemsOf(c.id))).toEqual(['user', 'assistant', 'user', 'notice:expired', 'assistant'])
    expect(await store.get(c.id)).toMatchObject({ sessionId: 'fake-session-1', sessionEngine: 'acp' })
  }, 20_000)

  it('an agent that resumes nothing reseeds every turn from the visible history, with no notice (a planned reseed)', async () => {
    script = { sessions: ['fake-session-1'], steps: [{ text: 'again' }] }
    const c = await store.create('gem', dir)
    await svc.send(c.id, 'one')
    await svc.send(c.id, 'two')
    await svc.send(c.id, 'three')
    expect(acpCalls.map((o) => o.start.kind)).toEqual(['new', 'resume', 'new', 'resume', 'new'])
    // Each later turn is seeded with the chat so far.
    expect(JSON.stringify(acpCalls[4].prompt)).toContain('two')
    expect(kinds(await itemsOf(c.id))).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant'])
    expect(await store.get(c.id)).toMatchObject({ sessionId: 'fake-session-1', sessionEngine: 'acp' })
  }, 30_000)

  it('a session another engine made is never handed to the agent: the turn starts fresh', async () => {
    const c = await store.create('gem', dir)
    await store.update(c.id, { sessionId: 'claude-session' })
    await svc.send(c.id, 'hi')
    expect(acpCalls.map((o) => o.start)).toEqual([{ kind: 'new' }])
    expect(JSON.stringify(acpCalls)).not.toContain('claude-session')
  }, 20_000)

  describe("the run gets none of ZumiBot's bridges", () => {
    it('no to-do, vault, ask, browser or process bridge, no bridge paragraph or board note, and no ZUMIBOT_* name in its env', async () => {
      const made = { todo: vi.fn(), vault: vi.fn(), ask: vi.fn(), browser: vi.fn(), proc: vi.fn(), note: vi.fn() }
      const turn = { mcp: NO_MCP, args: [], env: { ZUMIBOT_TODOS_CAPABILITY: 'cap' }, prompt: 'Browser prompt', dispose: () => {} }
      svc = makeService({
        todoTurns: {
          create: (o) => {
            made.todo(o)
            return turn
          }
        },
        vaultTurns: {
          create: (o) => {
            made.vault(o)
            return turn
          }
        },
        askTurns: {
          create: (o) => {
            made.ask(o)
            return turn
          }
        },
        askRoster: async () => [{ name: 'b', description: 'x' }],
        browserTurns: {
          profileId: async () => 'p',
          create: async (o) => {
            made.browser(o)
            return { ...turn, dispose: async () => {} }
          }
        },
        processTurns: {
          create: (o) => {
            made.proc(o)
            return turn
          }
        },
        // The board's note names the to-do tools, which an ACP agent does not have: it never reads it.
        todos: {
          note: async () => {
            made.note()
            return { text: 'BOARD NOTE', rev: 1 }
          },
          markSeen: async () => {},
          touch: () => null,
          settle: async () => {},
          endTurn: () => {}
        } as unknown as ChatServiceDeps['todos']
      })
      const c = await store.create('gem', dir)
      await svc.send(c.id, 'hi')
      for (const f of Object.values(made)) expect(f).not.toHaveBeenCalled()
      expect(acpCalls[0].systemPrompt).toBe(`${BODY}\n\n${RUN_SYSTEM}`)
      expect(acpCalls[0].systemPrompt).not.toContain(TODO_SYSTEM)
      expect(acpCalls[0].systemPrompt).not.toContain(VAULT_SYSTEM)
      expect(JSON.stringify(acpCalls[0].prompt)).not.toContain('BOARD NOTE')
      expect(Object.keys(acpCalls[0].env ?? {}).filter((k) => k.startsWith('ZUMIBOT_'))).toEqual([])
      // And nothing of ours reached the process either (the runner strips any that came from the base env).
      expect(lines(startFile())[0].envKeys.filter((k: string) => k.startsWith('ZUMIBOT_'))).toEqual([])
    }, 20_000)

    it('Pause is refused for an ACP chat', async () => {
      const c = await store.create('gem', dir)
      expect(await svc.canPause(c.id)).toBe(false)
    })
  })

  describe('launch trust', () => {
    it('a launch never confirmed in Agent Studio is refused, and nothing is spawned', async () => {
      await trust.remove(['gem'])
      const c = await store.create('gem', dir)
      await svc.send(c.id, 'hi')
      expect(acpCalls).toHaveLength(0)
      expect(await lastError(c.id)).toMatchObject({ text: ACP_TEXT.untrusted })
      expect(await store.get(c.id)).toMatchObject({ inFlight: false })
    })

    it('a launch changed outside Agent Studio (the command, an argument or a sign-in key) is refused', async () => {
      const c = await store.create('gem', dir)
      for (const changed of [
        { command: '/tmp/other', args: [FAKE], authEnv: [] },
        { command: process.execPath, args: [FAKE, '--debug'], authEnv: [] },
        { command: process.execPath, args: [FAKE], authEnv: ['OTHER_KEY'] }
      ]) {
        launch = changed
        await svc.send(c.id, 'hi')
        expect(await lastError(c.id)).toMatchObject({ text: ACP_TEXT.untrusted })
      }
      expect(acpCalls).toHaveLength(0)
    })

    it('a file whose provider is no longer acp (edited after the engine was read) never runs the confirmed launch', async () => {
      const c = await store.create('gem', dir)
      for (const p of [null, 'codex', 'ag-ui'] as const) {
        provider = p
        await svc.send(c.id, 'hi')
        expect(await lastError(c.id)).toMatchObject({ text: ACP_TEXT.untrusted })
      }
      expect(acpCalls).toHaveLength(0)
    })

    it('a refused argument is refused even when confirmed', async () => {
      launch = { command: process.execPath, args: [FAKE, '--yolo'], authEnv: [] }
      await trust.confirm('gem', acpRecord(launch))
      const c = await store.create('gem', dir)
      await svc.send(c.id, 'hi')
      expect(acpCalls).toHaveLength(0)
      expect(await lastError(c.id)).toMatchObject({ text: ACP_TEXT.refusedArg('--yolo') })
    })

    it('a command not found names the command; an agent file with no launch says to set one', async () => {
      located = () => null
      const c = await store.create('gem', dir)
      await svc.send(c.id, 'hi')
      expect(await lastError(c.id)).toMatchObject({ text: ACP_TEXT.notFound(process.execPath) })
      located = (command) => command
      launch = null
      await svc.send(c.id, 'hi')
      expect(await lastError(c.id)).toMatchObject({ text: ACP_TEXT.noCommand })
      expect(acpCalls).toHaveLength(0)
    })

    it('the launch is read and checked again on each attempt: a reseed after an outside edit is refused', async () => {
      script = { initialize: { agentCapabilities: { loadSession: true } }, sessions: [], steps: [{ text: 'fresh' }] }
      const c = await store.create('gem', dir)
      await store.update(c.id, { sessionId: 'gone', sessionEngine: 'acp' })
      // The edit lands while the first attempt runs: its resume fails, and the reseed reads the file again.
      svc = makeService({
        acp: {
          definitionOf: async () => ({ provider, body: BODY, launch }),
          trust: (agent, l) => trust.check(agent, acpRecord(l)),
          locate: async (command) => command,
          run: (o) => {
            const h = acpRun(o)
            launch = { command: process.execPath, args: [FAKE, '--other'], authEnv: [] }
            return h
          }
        }
      })
      await svc.send(c.id, 'next')
      expect(acpCalls).toHaveLength(1)
      expect(await lastError(c.id)).toMatchObject({ text: ACP_TEXT.untrusted })
    }, 20_000)
  })

  describe('sign-in keys (authEnv)', () => {
    const vaultEnv = () => ({
      env: { FAKE_ACP_KEY: KEY, OTHER_KEY: 'other-secret-value' },
      scrub: new Map([
        [KEY, '[vault: Fake key]'],
        ['other-secret-value', '[vault: Other]']
      ])
    })

    it("a named key reaches the agent's env under its own name, no other granted key does, and its value is scrubbed", async () => {
      launch = { command: process.execPath, args: [FAKE], authEnv: ['FAKE_ACP_KEY'] }
      await trust.confirm('gem', acpRecord(launch))
      script = { steps: [{ text: `my key is ${KEY}.` }] }
      svc = makeService({ vaultEnv })
      const c = await store.create('gem', dir)
      await svc.send(c.id, 'hi')
      expect(acpCalls[0].env).toMatchObject({ FAKE_ACP_KEY: KEY })
      expect(acpCalls[0].env).not.toHaveProperty('OTHER_KEY')
      const keys: string[] = lines(startFile())[0].envKeys
      expect(keys).toContain('FAKE_ACP_KEY')
      expect(keys).not.toContain('OTHER_KEY')
      const items = await itemsOf(c.id)
      expect(items[1]).toMatchObject({ type: 'assistant', text: 'my key is [vault: Fake key].' })
      expect(JSON.stringify(items)).not.toContain(KEY)
      expect(JSON.stringify(pushes)).not.toContain(KEY)
    }, 20_000)

    it('without authEnv no granted key reaches the agent', async () => {
      svc = makeService({ vaultEnv })
      const c = await store.create('gem', dir)
      await svc.send(c.id, 'hi')
      expect(acpCalls[0].env).not.toHaveProperty('FAKE_ACP_KEY')
      expect(acpCalls[0].env).not.toHaveProperty('OTHER_KEY')
    }, 20_000)

    it('a named key that is not granted (or a Vault that cannot be opened) fails the send naming the env name, never a value', async () => {
      launch = { command: process.execPath, args: [FAKE], authEnv: ['MISSING_KEY'] }
      await trust.confirm('gem', acpRecord(launch))
      svc = makeService({ vaultEnv })
      const c = await store.create('gem', dir)
      await svc.send(c.id, 'hi')
      expect(acpCalls).toHaveLength(0)
      expect(await lastError(c.id)).toMatchObject({ text: ACP_TEXT.authEnvMissing('MISSING_KEY') })
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        svc = makeService({
          vaultEnv: () => {
            throw new Error('vault locked')
          }
        })
        launch = { command: process.execPath, args: [FAKE], authEnv: ['FAKE_ACP_KEY'] }
        await trust.confirm('gem', acpRecord(launch))
        await svc.send(c.id, 'hi')
        expect(acpCalls).toHaveLength(0)
        expect(await lastError(c.id)).toMatchObject({ text: ACP_TEXT.authEnvMissing('FAKE_ACP_KEY') })
      } finally {
        log.mockRestore()
      }
    })
  })

  describe('approval cards', () => {
    const permission = (toolCall: object) => ({ permission: { toolCall } })
    const READ = { toolCallId: 't1', kind: 'read', title: 'Read a.txt', locations: [{ path: 'a.txt' }] }

    it("a card goes through the agent's rules: Allow always for this agent auto-allows the next AcpRead, always with allow_once", async () => {
      script = { steps: [permission(READ), { text: 'read it' }] }
      const c = await store.create('gem', dir)
      const first = svc.send(c.id, 'read')
      const card = await pendingCard(c.id)
      expect(card).toMatchObject({ toolName: 'AcpRead', input: { paths: ['a.txt'] }, toolUseId: expect.stringMatching(/:t1$/) })
      expect(card.onceOnly).toBeUndefined()
      svc.answer(c.id, card.id, 'allow-agent')
      await first
      expect(rules.added).toEqual([['gem', { key: JSON.stringify(['AcpRead']), toolName: 'AcpRead', command: null }]])
      expect((await cards(c.id)).map((x) => x.status)).toEqual(['allowed-agent'])
      script = { steps: [permission({ ...READ, toolCallId: 't2', locations: [{ path: 'b.txt' }] }), { text: 'read it' }] }
      await svc.send(c.id, 'read again')
      expect((await cards(c.id)).map((x) => x.status)).toEqual(['allowed-agent', 'auto-allowed-agent'])
      // "Always" is ZumiBot's own rule: the agent is only ever told allow_once.
      expect(answers()).toEqual([
        { outcome: { outcome: 'selected', optionId: 'allow-once' } },
        { outcome: { outcome: 'selected', optionId: 'allow-once' } }
      ])
    }, 20_000)

    it('an unclassified call (AcpCall) is once-only: Allow always and Allow for this chat are kept as Allow once, and it asks again', async () => {
      const c = await store.create('gem', dir)
      for (const decision of ['allow-agent', 'allow-chat'] as const) {
        script = { steps: [permission({ toolCallId: `t-${decision}`, kind: 'think', title: 'Ponder' }), { text: 'done' }] }
        const turn = svc.send(c.id, 'go')
        const card = await pendingCard(c.id)
        expect(card).toMatchObject({ toolName: 'AcpCall', onceOnly: true })
        svc.answer(c.id, card.id, decision)
        await turn
      }
      expect(rules.added).toEqual([])
      expect((await cards(c.id)).map((x) => x.status)).toEqual(['allowed-once', 'allowed-once'])
    }, 20_000)

    it('an AcpCall never auto-allows, even with a rule for it already stored', async () => {
      rules.add('gem', { key: JSON.stringify(['AcpCall']), toolName: 'AcpCall', command: null })
      script = { steps: [permission({ toolCallId: 't9', kind: 'other', title: 'Something' }), { text: 'done' }] }
      const c = await store.create('gem', dir)
      const turn = svc.send(c.id, 'go')
      const card = await pendingCard(c.id)
      expect(card.onceOnly).toBe(true)
      svc.answer(c.id, card.id, 'deny')
      await turn
      expect((await cards(c.id)).map((x) => x.status)).toEqual(['denied'])
      expect(answers()).toEqual([{ outcome: { outcome: 'selected', optionId: 'reject-once' } }])
    }, 20_000)

    it('an AcpEdit inside the chat folder may be remembered; one whose path leaves it is once-only', async () => {
      let id = 0
      const edit = (path: string) =>
        permission({ toolCallId: `e${++id}`, kind: 'edit', title: 'Edit', content: [{ type: 'diff', path, oldText: 'a', newText: 'b' }] })
      script = { steps: [edit(join(dir, 'in.txt')), { text: 'ok' }] }
      const c = await store.create('gem', dir)
      let turn = svc.send(c.id, 'edit')
      let card = await pendingCard(c.id)
      expect(card.onceOnly).toBeUndefined()
      svc.answer(c.id, card.id, 'allow-agent')
      await turn
      // The rule holds for the next edit inside the folder...
      script = { steps: [edit(join(dir, 'in.txt')), { text: 'ok' }] }
      await svc.send(c.id, 'edit again')
      expect((await cards(c.id)).map((x) => x.status)).toEqual(['allowed-agent', 'auto-allowed-agent'])
      // ...but never for one outside it.
      script = { steps: [edit('/etc/hosts'), { text: 'ok' }] }
      turn = svc.send(c.id, 'edit outside')
      card = await pendingCard(c.id)
      expect(card).toMatchObject({ toolName: 'AcpEdit', onceOnly: true })
      svc.answer(c.id, card.id, 'deny')
      await turn
      expect((await cards(c.id)).map((x) => x.status)).toEqual(['allowed-agent', 'auto-allowed-agent', 'denied'])
    }, 30_000)
  })

  it("an agent that reuses a tool call id (and its plan ids) in a later turn never touches the earlier turn's rows", async () => {
    const turn = (result: string) => ({
      steps: [
        { update: { sessionUpdate: 'plan', entries: [{ content: `Plan for ${result}`, status: 'pending', priority: 'high' }] } },
        { toolCall: { toolCallId: 'same', kind: 'read', title: 'Read a', locations: [{ path: 'a.txt' }], status: 'in_progress' } },
        { permission: { toolCall: { toolCallId: 'same' } } },
        {
          toolUpdate: { toolCallId: 'same', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: result } }] }
        },
        { text: 'done' }
      ]
    })
    const c = await store.create('gem', dir)
    for (const result of ['first result', 'second result']) {
      script = turn(result)
      const sending = svc.send(c.id, 'read')
      const card = await pendingCard(c.id)
      svc.answer(c.id, card.id, 'allow-once')
      await sending
    }
    const items = await itemsOf(c.id)
    // The fake resumes no session, so the second turn is a (planned, unnoticed) reseed: a new session, whose ids count from
    // the start again.
    expect(items.map((i) => (i.type === 'tool' ? `tool:${i.name}` : i.type === 'notice' ? `notice:${i.kind}` : i.type))).toEqual([
      'user',
      'tool:Plan',
      'tool:AcpRead',
      'approval',
      'assistant',
      'user',
      'tool:Plan',
      'tool:AcpRead',
      'approval',
      'assistant'
    ])
    const tools = items.filter((i): i is Extract<ChatItem, { type: 'tool' }> => i.type === 'tool')
    expect(new Set(tools.map((t) => t.id)).size).toBe(4)
    // Each turn keeps its own plan and its own result.
    expect(tools.map((t) => t.result)).toEqual([
      expect.stringContaining('Plan for first result'),
      'first result',
      expect.stringContaining('Plan for second result'),
      'second result'
    ])
    // Each card sits right after its own turn's row and names it.
    const reads = items.flatMap((i, at) => (i.type === 'tool' && i.name === 'AcpRead' ? [at] : []))
    for (const at of reads) expect(items[at + 1]).toMatchObject({ type: 'approval', toolUseId: items[at].id, status: 'allowed-once' })
  }, 30_000)

  it('a move is once-only even inside the chat folder, and even with an AcpEdit rule stored', async () => {
    rules.add('gem', { key: JSON.stringify(['AcpEdit']), toolName: 'AcpEdit', command: null })
    script = {
      steps: [
        {
          permission: {
            toolCall: {
              toolCallId: 'm1',
              kind: 'move',
              title: 'Move',
              locations: [{ path: join(dir, 'a.txt') }],
              rawInput: { destination: '/etc/x' }
            }
          }
        },
        { text: 'ok' }
      ]
    }
    const c = await store.create('gem', dir)
    const turn = svc.send(c.id, 'move')
    const card = await pendingCard(c.id)
    expect(card).toMatchObject({ toolName: 'AcpEdit', onceOnly: true, input: { move: true } })
    svc.answer(c.id, card.id, 'allow-chat')
    await turn
    expect((await cards(c.id)).map((x) => x.status)).toEqual(['allowed-once'])
  }, 20_000)

  it("in a task chat the agent's question (an elicitation) is declined, with no card", async () => {
    script = {
      steps: [
        {
          elicitation: {
            message: 'Pick',
            requestedSchema: { type: 'object', properties: { color: { type: 'string', enum: ['red', 'blue'] } } }
          }
        },
        { text: 'ok' }
      ]
    }
    const c = await store.create('gem', dir)
    await store.update(c.id, { task: { todoId: 't1' } })
    await svc.send(c.id, 'go')
    expect(answers()).toEqual([{ action: 'decline' }])
    expect(await cards(c.id)).toEqual([])
  }, 20_000)

  it("in an A→B chat (another agent asked) the agent's question is declined, with no card, and the asked system text reaches it", async () => {
    script = {
      steps: [
        {
          elicitation: {
            message: 'Pick',
            requestedSchema: { type: 'object', properties: { color: { type: 'string', enum: ['red', 'blue'] } } }
          }
        },
        { text: 'here is my answer' }
      ]
    }
    const c = await store.create('gem', dir)
    await store.update(c.id, { asked: { by: 'boss', from: 'parent-chat', fromTitle: 'Plans', chain: [] } })
    const out = await svc.runAsked(c.id, {
      from: 'boss',
      message: 'which colour?',
      chain: [],
      parent: 'parent-chat',
      signal: new AbortController().signal
    })
    expect(out.kind).toBe('ok')
    expect(answers()).toEqual([{ action: 'decline' }])
    expect(await cards(c.id)).toEqual([])
    expect(acpCalls[0].systemPrompt).toContain('You are being asked by the agent @boss')
  }, 20_000)

  it("an edit's diff lands on its tool row as an exact file change", async () => {
    const path = join(dir, 'f.txt')
    script = {
      steps: [
        {
          toolCall: {
            toolCallId: 'e1',
            kind: 'edit',
            title: 'Edit f.txt',
            status: 'in_progress',
            content: [{ type: 'diff', path, oldText: 'old\n', newText: 'new\n' }]
          }
        },
        { toolUpdate: { toolCallId: 'e1', status: 'completed' } },
        { text: 'edited' }
      ]
    }
    // What the agent's edit left on disk: the diff's new text is the whole file.
    writeFileSync(path, 'new\n')
    const snapshots = new SnapshotStore(join(dir, 'snaps'))
    svc = makeService({ snapshots, readFile: async (p) => fs.readFile(p) })
    const c = await store.create('gem', dir)
    await svc.send(c.id, 'edit')
    const tool = (await itemsOf(c.id)).find((i): i is Extract<ChatItem, { type: 'tool' }> => i.type === 'tool')!
    expect(tool).toMatchObject({ id: expect.stringMatching(/:e1$/), name: 'AcpEdit', isError: false })
    expect(tool.changes).toHaveLength(1)
    expect(tool.changes![0]).toMatchObject({ path, op: 'update' })
    expect(await snapshots.read(c.id, tool.changes![0].before!)).toBe('old\n')
    expect(await snapshots.read(c.id, tool.changes![0].after!)).toBe('new\n')
  }, 20_000)

  it('a call whose input arrives late (as claude-agent-acp sends it) is stored as Bash {command}, its card right after the row', async () => {
    script = {
      steps: [
        { toolCall: { toolCallId: 'b1', kind: 'execute', title: 'Terminal', status: 'pending', rawInput: {} } },
        { permission: { toolCall: { toolCallId: 'b1', kind: 'execute', title: 'ls', rawInput: { command: 'ls' } } } },
        { toolUpdate: { toolCallId: 'b1', rawInput: { command: 'ls', description: 'List files' } } },
        { toolUpdate: { toolCallId: 'b1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'f.txt' } }] } },
        { text: 'listed' }
      ]
    }
    const c = await store.create('gem', dir)
    const turn = svc.send(c.id, 'list')
    const card = await pendingCard(c.id)
    expect(card).toMatchObject({ toolName: 'Bash', input: { command: 'ls' } })
    svc.answer(c.id, card.id, 'allow-once')
    await turn
    const items = await itemsOf(c.id)
    expect(kinds(items)).toEqual(['user', 'tool', 'approval', 'assistant'])
    expect(items[1]).toMatchObject({
      type: 'tool',
      id: expect.stringMatching(/:b1$/),
      name: 'Bash',
      input: { command: 'ls' },
      result: 'f.txt',
      isError: false
    })
    expect(items[2]).toMatchObject({ type: 'approval', toolUseId: items[1].id, status: 'allowed-once' })
  }, 20_000)
})

describe('isolation and the audit log for an ACP agent', () => {
  const isoService = async (level: 'sandbox' | 'container') => {
    const iso = new IsolationService({
      file: join(dir, 'audit', 'isolation.json'),
      home: dir,
      dataDir: join(dir, 'data'),
      keyDir: join(dir, 'key'),
      pathEnv: async () => '',
      fileHook: null,
      checkSupport: async () => ({ available: true })
    })
    await iso.start()
    await iso.set('gem', { level, write: [], read: [], network: [], webSearch: false, autoBash: false })
    return iso
  }

  it('an ACP agent set to Sandboxed or Container (it was a Claude agent then) is refused with a fixed line, never run as Off', async () => {
    for (const level of ['sandbox', 'container'] as const) {
      svc = makeService({ isolation: await isoService(level) })
      const c = await store.create('gem', dir)
      await svc.send(c.id, 'hi')
      expect(acpCalls).toHaveLength(0)
      expect(await lastError(c.id)).toMatchObject({ text: isolationRefusal('acp', level) })
    }
  })

  it('the belt: a level the isolation service let through for an ACP run is still refused before anything spawns', async () => {
    svc = makeService({ isolation: { levelOf: () => 'sandbox', runFor: async () => ({ level: 'sandbox', settings: '{}', network: [] }) } })
    const c = await store.create('gem', dir)
    await svc.send(c.id, 'hi')
    expect(acpCalls).toHaveLength(0)
    expect(await lastError(c.id)).toMatchObject({ text: isolationRefusal('acp', 'sandbox') })
  })

  it("an ACP agent's call is audited like Claude's: its card's answer, under engine acp", async () => {
    const records: Omit<AuditRecord, 'prev'>[] = []
    svc = makeService({
      audit: new AuditService({
        machine: 'm1',
        now: () => 1,
        newId: () => `r${records.length}`,
        write: (r) => {
          records.push(r)
        }
      })
    })
    script = {
      steps: [
        { permission: { toolCall: { toolCallId: 'b1', kind: 'execute', title: 'ls', rawInput: { command: 'ls' } } } },
        { text: 'listed' }
      ]
    }
    const c = await store.create('gem', dir)
    const turn = svc.send(c.id, 'list')
    const card = await pendingCard(c.id)
    svc.answer(c.id, card.id, 'allow-once')
    await turn
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      engine: 'acp',
      agent: 'gem',
      tool: 'Bash',
      decision: { kind: 'approvedByUser', scope: 'once' },
      isolation: 'off'
    })
  }, 20_000)
})

describe("/todo and an agent without ZumiBot's to-do tools", () => {
  const refusal = todoRefusal('acp', 'gem')
  const history = async (id: string) => {
    await store.saveItems(id, [
      { type: 'user', id: 'u1', text: '/todo plan the day', ts: 1, todo: true },
      { type: 'assistant', id: 'a1', text: 'ok', ts: 2 }
    ] as ChatItem[])
  }

  it("a resend of a /todo message is refused before any run, as the turn's error, and the chat keeps its items", async () => {
    const c = await store.create('gem', dir)
    await history(c.id)
    await svc.rerun(c.id, 'u1', null)
    expect(acpCalls).toHaveLength(0)
    expect(claudeRun).not.toHaveBeenCalled()
    expect((await lastError(c.id))?.text).toContain(refusal)
    expect(kinds(await itemsOf(c.id))).toEqual(['user', 'assistant', 'error'])
    expect((await store.get(c.id))?.inFlight).toBe(false)
  })

  it('a send that arrives with the flag, or with a command that makes to-dos (a routine or workflow step), is refused the same way', async () => {
    const c = await store.create('gem', dir)
    await svc.send(c.id, '/todo plan', [], undefined, undefined, undefined, true)
    await svc.send(c.id, '/day', [], undefined, undefined, { agent: 'gem', name: 'day', prompt: 'Plan the day', todos: true })
    expect(acpCalls).toHaveLength(0)
    expect((await itemsOf(c.id)).filter((i) => i.type === 'error').map((i) => (i as { text: string }).text)).toEqual([refusal, refusal])
    expect((await itemsOf(c.id)).some((i) => i.type === 'user')).toBe(false)
  })

  it('a plain message, and a command without the flag, still run', async () => {
    const c = await store.create('gem', dir)
    await svc.send(c.id, 'hi')
    await svc.send(c.id, '/check', [], undefined, undefined, { agent: 'gem', name: 'check', prompt: 'Check it' })
    expect(acpCalls.length).toBeGreaterThan(0)
    expect((await itemsOf(c.id)).some((i) => i.type === 'error' && i.text.includes(refusal))).toBe(false)
  })
})
