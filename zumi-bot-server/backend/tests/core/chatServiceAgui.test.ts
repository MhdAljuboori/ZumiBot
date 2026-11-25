import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { isolationRefusal, todoRefusal } from '@zumibot/shared/engine'
import { ChatStore } from '../../src/core/store/chatStore'
import { AttachmentStore } from '../../src/core/attachments/attachmentStore'
import { ChatService, MODEL_REFUSED, type ChatServiceDeps } from '../../src/core/chat/chatService'
import { startAgui, type AguiRunOptions } from '../../src/core/agui/aguiRunner'
import { aguiRecord, LaunchTrust } from '../../src/core/acp/launchTrust'
import { AGUI_TOOL } from '../../src/core/agui/aguiEvents'
import { RUN_SYSTEM } from '../../src/core/processes/processPrompt'
import { forkChat } from '../../src/core/chat/fork'
import type { Provider } from '@zumibot/shared/engine'
import { NO_MCP } from '../../src/core/ipc/mcpSpec'
import { AuditService } from '../../src/core/audit/auditService'
import type { AuditRecord } from '@zumibot/shared/audit'
import { AGUI_TEXT, type AguiLaunch } from '@zumibot/shared/agui'
import { QUESTION_TOOL } from '@zumibot/shared/questions'
import type { ChatItem, ChatPush } from '@zumibot/shared/types'
import { startFakeAgui, stopFakeAgui, type AguiStep, type FakeAgui } from '../support/fakeAgui'

// Remote (AG-UI) agents through ChatService, against the fake server (fake-agui-server.mjs) reached by the real runner under
// the dev hook, as app.ts wires it. See docs/architecture/protocol-engines.md, AG-UI engine.

const KEY = 'sk-remote-9f2c41aa'
const LABEL = '[vault: Agent key]'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

let dir: string
let store: ChatStore
let files: AttachmentStore
let trust: LaunchTrust
let f: FakeAgui
let pushes: ChatPush[]
let calls: AguiRunOptions[]
let n: number
let launch: AguiLaunch | null
let provider: Provider | null
let keyValue: string
let svc: ChatService
const claudeRun = vi.fn()

const vaultEnv = () => ({
  env: { AGENT_KEY: keyValue, OTHER_KEY: 'other-secret-value' },
  scrub: new Map([
    [keyValue, LABEL],
    ['other-secret-value', '[vault: Other]']
  ])
})

const makeService = (extra: Partial<ChatServiceDeps> = {}, allowLocal = true) =>
  new ChatService({
    store,
    files,
    locate: async () => '/bin/claude',
    run: (o) => {
      claudeRun(o)
      throw new Error('claude must not run for a remote agent')
    },
    push: (p) => pushes.push(p),
    now: () => 1000 + n,
    newId: () => `x${++n}`,
    permissionMode: 'manual',
    disallowedToolsFor: () => [],
    vaultEnv,
    engineOf: async (agent) => (agent === 'rem' ? 'ag-ui' : 'claude'),
    agui: {
      definitionOf: async (agent) => (agent === 'rem' ? { provider, launch } : null),
      trust: (agent, l) => trust.check(agent, aguiRecord(l)),
      allowLocal,
      run: (o) => {
        calls.push(o)
        return startAgui(o)
      },
      thread: { load: (id) => store.loadAgui(id), save: (id, t) => store.saveAgui(id, t) }
    },
    ...extra
  })

const script = (...requests: AguiStep[][]) => f.script(requests)

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-agui-svc-'))
  store = new ChatStore(dir)
  files = new AttachmentStore(join(dir, 'attachments'), () => 'unused')
  trust = new LaunchTrust(join(dir, 'data'))
  await trust.load()
  f = await startFakeAgui([[{ text: 'hello there' }, { finish: {} }]])
  pushes = []
  calls = []
  n = 0
  keyValue = KEY
  launch = { endpoint: f.url, authKey: 'AGENT_KEY', authHeader: null }
  provider = 'ag-ui'
  claudeRun.mockClear()
  await trust.confirm('rem', aguiRecord(launch))
  svc = makeService()
})
afterEach(async () => {
  await stopFakeAgui()
  await fs.rm(dir, { recursive: true, force: true })
})

const itemsOf = (id: string) => store.loadItems(id)
const kinds = (items: ChatItem[]) => items.map((i) => (i.type === 'notice' ? `notice:${i.kind}` : i.type))
const lastError = async (id: string) =>
  (await itemsOf(id)).filter((i): i is Extract<ChatItem, { type: 'error' }> => i.type === 'error').pop()
const users = async (id: string) => (await itemsOf(id)).filter((i): i is Extract<ChatItem, { type: 'user' }> => i.type === 'user')
type Card = Extract<ChatItem, { type: 'approval' }>
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
// An interrupt whose schema maps as a question card: one yes/no question.
const approval = (id: string, extra: object = {}) => ({
  id,
  reason: 'tool_approval',
  message: 'Run the deploy?',
  responseSchema: { type: 'object', properties: { approved: { type: 'boolean', title: 'Approve' } }, required: ['approved'] },
  ...extra
})
const interrupt = (...interrupts: object[]): AguiStep => ({ finish: { outcome: { type: 'interrupt', interrupts } } })

describe('remote (AG-UI) agents in ChatService', () => {
  it("marks the turn's message as a remote one before the first request, so a turn a hard crash cut short is not foreign", async () => {
    script([{ sleep: 1000 }, { text: 'late' }, { finish: {} }])
    const c = await store.create('rem', dir)
    const turn = svc.send(c.id, 'hi')
    await vi.waitFor(() => expect(f.requests()).toHaveLength(1), { timeout: 10_000, interval: 20 })
    // On disk as the request is made, with nothing of the reply yet.
    expect(kinds(await itemsOf(c.id))).toEqual(['user'])
    expect((await users(c.id))[0]).toMatchObject({ engine: 'ag-ui' })
    await turn
    // The turn as a kill -9 would have left it: no end stamp, and the notice recovery adds.
    const [u, reply] = await itemsOf(c.id)
    const { end: _end, ...unstamped } = reply
    await store.saveItems(c.id, [u, unstamped as ChatItem, { type: 'notice', id: 'n1', kind: 'interrupted', text: 'Interrupted.', ts: 2 }])
    script([{ text: 'again' }, { finish: {} }])
    await svc.send(c.id, 'next')
    expect(await lastError(c.id)).toBeUndefined()
    expect(f.requests()).toHaveLength(2)
    expect(f.requests()[1].body.messages.map((m: { content?: string }) => m.content)).toEqual(['hi', 'late', 'next'])
  })

  it('sends a message the same text on every run: its command filled in and the reply it quotes, as its own run sent it', async () => {
    const c = await store.create('rem', dir)
    await svc.send(c.id, 'hi')
    const [, first] = await itemsOf(c.id)
    script([{ text: 'checked' }, { finish: {} }])
    await svc.send(c.id, '/check', [], first.id, undefined, { agent: 'rem', name: 'check', prompt: 'Check the docs' })
    script([{ text: 'ok' }, { finish: {} }])
    await svc.send(c.id, 'third')
    const [, second, third] = f.requests()
    const own = second.body.messages.at(-1)
    expect(own.role).toBe('user')
    expect(own.content).toContain('Check the docs')
    expect(own.content).toContain('hello there')
    expect(own.content).not.toContain('/check')
    expect(third.body.messages.find((m: { id: string }) => m.id === own.id)).toEqual(own)
    // Every message keeps its first run's text, the earlier ones too.
    expect(third.body.messages.slice(0, second.body.messages.length)).toEqual(second.body.messages)
  })

  it('a turn of another engine leaves its message unmarked', async () => {
    const c = await store.create('alpha', dir)
    await svc.send(c.id, 'hi')
    const [u] = await users(c.id)
    expect(Object.hasOwn(u, 'engine')).toBe(false)
  })

  it('a model picked by hand is refused (no models cap), and nothing is stored', async () => {
    const c = await store.create('rem', dir)
    await expect(svc.setModel(c.id, 'opus')).rejects.toThrow(MODEL_REFUSED)
    expect((await store.get(c.id))?.model).toBeUndefined()
  })

  it("a send runs the remote agent (never claude), records the session as ag-ui and stamps the turn's end with that mark", async () => {
    const c = await store.create('rem', dir)
    await svc.send(c.id, 'hi')
    expect(claudeRun).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
    // The dev hook is this service's own, added to the adapter's request.
    expect(calls[0]).toMatchObject({ endpoint: f.url, authKey: 'AGENT_KEY', allowLocal: true, thread: null })
    expect(typeof calls[0].requestTag).toBe('string')
    const [req] = f.requests()
    const [u] = await users(c.id)
    expect(req.body.threadId).toMatch(UUID)
    expect(req.body.messages).toEqual([{ id: u.id, role: 'user', content: 'hi' }])
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`)
    const items = await itemsOf(c.id)
    expect(kinds(items)).toEqual(['user', 'assistant'])
    expect(items[1]).toMatchObject({ type: 'assistant', text: 'hello there' })
    expect(await store.get(c.id)).toMatchObject({ sessionId: req.body.threadId, sessionEngine: 'ag-ui', inFlight: false })
    // The end stamp carries the mark, so the next turn's history reads as this engine's own (foreignHistory).
    expect(items[1].end).toEqual({ session: req.body.threadId, at: req.body.runId, engine: 'ag-ui' })
    expect(items[1].sent).toBeUndefined()
    // The thread file is kept beside the chat, and no side base (no `btw`).
    expect(await store.loadAgui(c.id)).toEqual({ v: 1, threadId: req.body.threadId, state: {}, interrupts: [] })
    expect(svc.sideBase(c.id, 'rem')).toBeNull()
  }, 20_000)

  it("the second turn sends the first turn's messages on the same thread, and its kept state", async () => {
    script([{ state: { snapshot: { step: 1 } } }, { text: 'first answer' }, { finish: {} }], [{ text: 'second answer' }, { finish: {} }])
    const c = await store.create('rem', dir)
    await svc.send(c.id, 'one')
    await svc.send(c.id, 'two')
    const [one, two] = f.requests()
    expect(two.body.threadId).toBe(one.body.threadId)
    expect(two.body.state).toEqual({ step: 1 })
    const items = await itemsOf(c.id)
    expect(kinds(items)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(two.body.messages).toEqual([
      { id: items[0].id, role: 'user', content: 'one' },
      { id: items[1].id, role: 'assistant', content: 'first answer' },
      { id: items[2].id, role: 'user', content: 'two' }
    ])
    // Each attempt read the thread file as kept.
    expect(calls[1].thread).toMatchObject({ threadId: one.body.threadId, state: { step: 1 } })
  }, 20_000)

  it('an Edit, a Resend and a version switch start a new thread with the visible items, and say nothing of it (no expired notice)', async () => {
    script([{ state: { snapshot: { step: 1 } } }, { text: 'hello there' }, { finish: {} }], [{ text: 'hello there' }, { finish: {} }])
    const c = await store.create('rem', dir)
    await svc.send(c.id, 'one')
    await svc.send(c.id, 'two')
    const firstThread = f.requests()[0].body.threadId
    expect(f.requests()[1].body.state).toEqual({ step: 1 })
    const two = (await users(c.id))[1]
    await svc.rerun(c.id, two.id, 'two edited')
    const edited = f.requests()[2]
    expect(edited.body.threadId).toMatch(UUID)
    expect(edited.body.threadId).not.toBe(firstThread)
    expect(edited.body.resume).toBeUndefined()
    // A new thread starts from no state (Rulings 3): the old thread's is the server's, and stays with it.
    expect(edited.body.state).toEqual({})
    const shown = await itemsOf(c.id)
    expect(kinds(shown)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(edited.body.messages).toEqual([
      { id: shown[0].id, role: 'user', content: 'one' },
      { id: shown[1].id, role: 'assistant', content: 'hello there' },
      { id: shown[2].id, role: 'user', content: 'two edited' }
    ])
    expect(await store.get(c.id)).toMatchObject({ sessionId: edited.body.threadId, sessionEngine: 'ag-ui' })
    expect((await store.loadAgui(c.id))?.threadId).toBe(edited.body.threadId)
    // Resend: the same text, on yet another thread.
    await svc.rerun(c.id, shown[2].id, null)
    const resent = f.requests()[3]
    expect(new Set([firstThread, edited.body.threadId, resent.body.threadId]).size).toBe(3)
    expect(resent.body.messages.map((m: { content: string }) => m.content)).toEqual(['one', 'hello there', 'two edited'])
    // Back to the first version, then a send: its stamp is the old thread's, so it reseeds onto a new one with what is shown.
    await svc.switchVersion(c.id, (await users(c.id))[1].id, 0)
    await svc.send(c.id, 'three')
    const after = f.requests()[4]
    expect(after.body.messages.map((m: { content: string }) => m.content)).toEqual(['one', 'hello there', 'two', 'hello there', 'three'])
    expect(kinds(await itemsOf(c.id)).filter((k) => k.startsWith('notice'))).toEqual([])
  }, 30_000)

  it('a Fork starts its own thread with the history up to the point, and says nothing of it (no expired notice)', async () => {
    script([{ state: { snapshot: { step: 1 } } }, { text: 'hello there' }, { finish: {} }], [{ text: 'hello there' }, { finish: {} }])
    const c = await store.create('rem', dir)
    await svc.send(c.id, 'one')
    await svc.send(c.id, 'two')
    const firstThread = f.requests()[0].body.threadId
    const reply = (await itemsOf(c.id))[1]
    const { chat } = await forkChat({ store, files, now: () => 5000 }, c.id, reply.id)
    await svc.send(chat.id, 'branch')
    const forked = f.requests()[2]
    expect(forked.body.threadId).toMatch(UUID)
    expect(forked.body.threadId).not.toBe(firstThread)
    expect(forked.body.state).toEqual({})
    expect(forked.body.resume).toBeUndefined()
    const items = await itemsOf(chat.id)
    expect(kinds(items)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(forked.body.messages).toEqual([
      { id: items[0].id, role: 'user', content: 'one' },
      { id: items[1].id, role: 'assistant', content: 'hello there' },
      { id: items[2].id, role: 'user', content: 'branch' }
    ])
    expect(await store.get(chat.id)).toMatchObject({ sessionId: forked.body.threadId, sessionEngine: 'ag-ui' })
    // The source chat keeps its own thread.
    expect(await store.get(c.id)).toMatchObject({ sessionId: firstThread })
  }, 30_000)

  describe('history quoting local work never reaches the remote host (Review Focus 1)', () => {
    it('a chat a Claude turn ran in is refused before any request, and keeps its Claude session', async () => {
      const c = await store.create('rem', dir)
      await store.saveItems(c.id, [
        { type: 'user', id: 'u0', text: 'read my .env', ts: 1 },
        { type: 'assistant', id: 'a0', text: 'It holds TOKEN=abc', ts: 2, end: { session: 'claude-session', at: 'e1' } }
      ])
      await store.update(c.id, { sessionId: 'claude-session' })
      await svc.send(c.id, 'go on')
      expect(f.requests()).toEqual([])
      expect(calls).toEqual([])
      expect(await lastError(c.id)).toMatchObject({ text: AGUI_TEXT.otherEngine })
      expect(await store.get(c.id)).toMatchObject({ sessionId: 'claude-session', inFlight: false })
    }, 20_000)

    it("so is a chat with work no turn stamped (a crash), and one with another engine's cut", async () => {
      for (const earlier of [
        [
          { type: 'user', id: 'u0', text: 'q', ts: 1 },
          {
            type: 'tool',
            id: 't0',
            name: 'Bash',
            input: { command: 'cat .env' },
            result: 'TOKEN=abc',
            isError: false,
            blocked: false,
            ts: 2
          }
        ],
        [
          { type: 'user', id: 'u0', text: 'q', ts: 1 },
          {
            type: 'assistant',
            id: 'a0',
            text: 'x',
            ts: 2,
            cut: { session: 'th', at: 't1', engine: 'codex' },
            end: { session: 'th', at: 't1', engine: 'ag-ui' }
          }
        ]
      ] as ChatItem[][]) {
        const c = await store.create('rem', dir)
        await store.saveItems(c.id, earlier)
        await svc.send(c.id, 'go on')
        expect(await lastError(c.id)).toMatchObject({ text: AGUI_TEXT.otherEngine })
      }
      expect(f.requests()).toEqual([])
    }, 20_000)
  })

  describe('refusals, each before any request', () => {
    it('an attachment is refused', async () => {
      const c = await store.create('rem', dir)
      await svc.send(c.id, 'see this', [{ id: 'f1', name: 'notes.txt', mime: 'text/plain', size: 3, kind: 'file' }])
      expect(await lastError(c.id)).toMatchObject({ text: AGUI_TEXT.noAttachments })
      expect(f.requests()).toEqual([])
    }, 20_000)

    it('a launch never confirmed, or changed outside Agent Studio (endpoint, key or header), is refused', async () => {
      const c = await store.create('rem', dir)
      await trust.remove(['rem'])
      await svc.send(c.id, 'hi')
      expect(await lastError(c.id)).toMatchObject({ text: AGUI_TEXT.untrusted })
      const confirmed = { endpoint: f.url, authKey: 'AGENT_KEY', authHeader: null }
      await trust.confirm('rem', aguiRecord(confirmed))
      for (const changed of [
        { ...confirmed, endpoint: `${f.origin}/other` },
        { ...confirmed, authKey: 'OTHER_KEY' },
        { ...confirmed, authHeader: 'X-Api-Key' }
      ]) {
        launch = changed
        await svc.send(c.id, 'hi')
        expect(await lastError(c.id)).toMatchObject({ text: AGUI_TEXT.untrusted })
      }
      expect(f.requests()).toEqual([])
      expect(calls).toEqual([])
    }, 20_000)

    it('a file whose provider is no longer ag-ui (edited after the engine was read) never runs the confirmed endpoint', async () => {
      const c = await store.create('rem', dir)
      for (const p of [null, 'codex', 'acp'] as const) {
        provider = p
        await svc.send(c.id, 'hi')
        expect(await lastError(c.id)).toMatchObject({ text: AGUI_TEXT.untrusted })
      }
      expect(f.requests()).toEqual([])
      expect(calls).toEqual([])
    }, 20_000)

    it('no endpoint, and an endpoint the URL check refuses, each say so; the dev hook comes only from the deps', async () => {
      const c = await store.create('rem', dir)
      launch = null
      await svc.send(c.id, 'hi')
      expect(await lastError(c.id)).toMatchObject({ text: AGUI_TEXT.noEndpoint })
      // Plain http to loopback without the dev hook: refused by the URL check, before trust is even read.
      launch = { endpoint: f.url, authKey: 'AGENT_KEY', authHeader: null }
      svc = makeService({}, false)
      await svc.send(c.id, 'hi')
      expect(await lastError(c.id)).toMatchObject({ text: AGUI_TEXT.endpointInvalid })
      expect(f.requests()).toEqual([])
    }, 20_000)

    describe('the order: each refusal is the first that applies', () => {
      const file = { id: 'f1', name: 'notes.txt', mime: 'text/plain', size: 3, kind: 'file' as const }
      const claudeTurn: ChatItem[] = [
        { type: 'user', id: 'u0', text: 'q', ts: 1 },
        { type: 'assistant', id: 'a0', text: 'claude did this', ts: 2 }
      ]
      afterEach(() => expect(f.requests()).toEqual([]))

      it('an invalid URL (2) before an untrusted launch (3)', async () => {
        await trust.remove(['rem'])
        svc = makeService({}, false)
        const c = await store.create('rem', dir)
        await svc.send(c.id, 'hi')
        expect(await lastError(c.id)).toMatchObject({ text: AGUI_TEXT.endpointInvalid })
      }, 20_000)

      it('an untrusted launch (3) before the history (4) or an attachment (5)', async () => {
        await trust.remove(['rem'])
        const c = await store.create('rem', dir)
        await store.saveItems(c.id, claudeTurn)
        await svc.send(c.id, 'see this', [file])
        expect(await lastError(c.id)).toMatchObject({ text: AGUI_TEXT.untrusted })
      }, 20_000)

      it("another engine's history (4) before an attachment (5)", async () => {
        const c = await store.create('rem', dir)
        await store.saveItems(c.id, claudeTurn)
        await svc.send(c.id, 'see this', [file])
        expect(await lastError(c.id)).toMatchObject({ text: AGUI_TEXT.otherEngine })
      }, 20_000)

      it('an attachment (5) before a key not granted (6)', async () => {
        launch = { endpoint: f.url, authKey: 'MISSING_KEY', authHeader: null }
        await trust.confirm('rem', aguiRecord(launch))
        const c = await store.create('rem', dir)
        await svc.send(c.id, 'see this', [file])
        expect(await lastError(c.id)).toMatchObject({ text: AGUI_TEXT.noAttachments })
        await svc.send(c.id, 'no file')
        expect(await lastError(c.id)).toMatchObject({ text: AGUI_TEXT.authKeyMissing('MISSING_KEY') })
      }, 20_000)
    })

    it('an auth key not granted, or one no header can carry, is refused naming the env name, never a value', async () => {
      const c = await store.create('rem', dir)
      launch = { endpoint: f.url, authKey: 'MISSING_KEY', authHeader: null }
      await trust.confirm('rem', aguiRecord(launch))
      await svc.send(c.id, 'hi')
      expect(await lastError(c.id)).toMatchObject({ text: AGUI_TEXT.authKeyMissing('MISSING_KEY') })
      launch = { endpoint: f.url, authKey: 'AGENT_KEY', authHeader: null }
      await trust.confirm('rem', aguiRecord(launch))
      for (const bad of ['abc\ndef', 'abc\rdef', 'abc\0def', 'abc\x01def', 'abc\x7fdef', 'abc\u0100def', 'key-€', 'emoji-😀']) {
        keyValue = bad
        await svc.send(c.id, 'hi')
        expect(await lastError(c.id)).toMatchObject({ text: AGUI_TEXT.authKeyUnusable('AGENT_KEY') })
      }
      expect(f.requests()).toEqual([])
      // Latin-1 and a tab are fine: the request goes out.
      keyValue = 'clé-ÿ\tx'
      await svc.send(c.id, 'hi')
      expect(f.requests()).toHaveLength(1)
    }, 20_000)
  })

  describe('the auth header', () => {
    it('Authorization (any case) sends Bearer <value>; another header sends the bare value; no key sends none', async () => {
      const c = await store.create('rem', dir)
      for (const authHeader of ['authorization', 'X-Api-Key']) {
        launch = { endpoint: f.url, authKey: 'AGENT_KEY', authHeader }
        await trust.confirm('rem', aguiRecord(launch))
        await svc.send(c.id, 'hi')
      }
      launch = { endpoint: f.url, authKey: null, authHeader: null }
      await trust.confirm('rem', aguiRecord(launch))
      await svc.send(c.id, 'hi')
      const [a, b, none] = f.requests()
      expect(a.headers.authorization).toBe(`Bearer ${KEY}`)
      expect(b.headers['x-api-key']).toBe(KEY)
      expect(b.headers.authorization).toBeUndefined()
      expect(none.headers.authorization).toBeUndefined()
      expect(none.headers['x-api-key']).toBeUndefined()
      // Only ever in its header: never in a body, and never in what the chat stores or shows.
      expect(JSON.stringify(f.requests().map((r) => r.body))).not.toContain(KEY)
      expect(JSON.stringify([await itemsOf(c.id), pushes])).not.toContain(KEY)
    }, 20_000)
  })

  it('a RUN_ERROR echoing the key shows the scrub label, with its code (R-P1)', async () => {
    script([{ text: `trying ${KEY}` }, { error: { message: `bad key ${KEY}`, code: 'AUTH' } }])
    const c = await store.create('rem', dir)
    await svc.send(c.id, 'hi')
    expect(await lastError(c.id)).toMatchObject({ text: AGUI_TEXT.runError(`bad key ${LABEL}`, 'AUTH') })
    const items = await itemsOf(c.id)
    expect(items.find((i) => i.type === 'assistant')).toMatchObject({ text: `trying ${LABEL}` })
    expect(JSON.stringify([items, pushes])).not.toContain(KEY)
    // A run that failed after starting still ends its turn on the thread: the next turn's history is its own.
    expect(items.at(-1)?.end).toMatchObject({ engine: 'ag-ui' })
  }, 20_000)

  it('a remote notice is shown as a remote notice, scrubbed', async () => {
    script([interrupt({ id: 'int-x', reason: `needs ${KEY}` })], [{ text: 'ok' }, { finish: {} }])
    const c = await store.create('rem', dir)
    await svc.send(c.id, 'hi')
    const notices = (await itemsOf(c.id)).filter((i): i is Extract<ChatItem, { type: 'notice' }> => i.type === 'notice')
    expect(notices).toEqual([expect.objectContaining({ kind: 'remote', text: AGUI_TEXT.interruptDeclined(`needs ${LABEL}`) })])
    expect(JSON.stringify(pushes)).not.toContain(KEY)
  }, 20_000)

  it('a question card is answered through the real card path, and the run resumes on the same thread', async () => {
    script(
      [
        { text: 'Deploying.', id: 'm1' },
        { tool: { id: 'call_9', name: 'deploy', args: { env: 'prod' }, parent: 'm1' } },
        interrupt(approval('int-1', { toolCallId: 'call_9' }))
      ],
      [{ tool: { id: 'call_9', name: 'deploy', args: { env: 'prod' }, result: 'deployed' } }, { text: 'Deployed.' }, { finish: {} }]
    )
    const c = await store.create('rem', dir)
    const turn = svc.send(c.id, 'deploy it')
    const card = await pendingCard(c.id)
    expect(card).toMatchObject({ toolName: QUESTION_TOOL, toolUseId: expect.stringMatching(/:call_9$/) })
    const q = (card.input as { questions: { question: string; options: { label: string }[] }[] }).questions[0]
    svc.answerQuestions(c.id, card.id, { [q.question]: q.options[0].label })
    await turn
    const [one, two] = f.requests()
    expect(two.body.threadId).toBe(one.body.threadId)
    expect(two.body.resume).toEqual([{ interruptId: 'int-1', status: 'resolved', payload: { approved: true } }])
    const items = await itemsOf(c.id)
    expect(kinds(items)).toEqual(['user', 'assistant', 'tool', 'approval', 'assistant'])
    expect(items.find((i) => i.type === 'approval')).toMatchObject({ status: 'answered' })
    expect(items.find((i) => i.type === 'tool')).toMatchObject({ name: AGUI_TOOL, result: 'deployed', isError: false })
    // Two runs, so two inits and two entries: one session saved, and one end stamp, at the last run.
    expect(items.filter((i) => i.end !== undefined)).toHaveLength(1)
    expect(items.at(-1)?.end).toEqual({ session: one.body.threadId, at: two.body.runId, engine: 'ag-ui' })
    expect(await store.get(c.id)).toMatchObject({ sessionId: one.body.threadId, sessionEngine: 'ag-ui' })
    expect(await store.loadAgui(c.id)).toMatchObject({ threadId: one.body.threadId, interrupts: [] })
  }, 20_000)

  it('an empty message before a tool call (as Pydantic AI sends one) stores no empty reply, in either round of an approval', async () => {
    // Pydantic AI 2.65's shape, recorded from a real server: TEXT_MESSAGE_START/END with nothing between, then the call with
    // that message as its parent, then the interrupt; the resumed run sends the result and the reply.
    const empty = (id: string): AguiStep[] => [
      { raw: { type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' } },
      { raw: { type: 'TEXT_MESSAGE_END', messageId: id } }
    ]
    script(
      [
        ...empty('m0'),
        { tool: { id: 'call_1', name: 'delete_demo_file', args: { path: 'demo.txt' }, parent: 'm0' } },
        interrupt(approval('int-call_1', { toolCallId: 'call_1' }))
      ],
      [
        { raw: { type: 'TOOL_CALL_RESULT', messageId: 'r1', toolCallId: 'call_1', content: 'pretended to delete demo.txt', role: 'tool' } },
        ...empty('m1'),
        { text: 'done: pretended to delete demo.txt' },
        { finish: {} }
      ]
    )
    const c = await store.create('rem', dir)
    const turn = svc.send(c.id, 'Run the approval demo')
    const card = await pendingCard(c.id)
    const q = (card.input as { questions: { question: string; options: { label: string }[] }[] }).questions[0]
    svc.answerQuestions(c.id, card.id, { [q.question]: 'Yes' })
    await turn
    const items = await itemsOf(c.id)
    expect(kinds(items)).toEqual(['user', 'tool', 'approval', 'assistant'])
    expect(items.filter((i) => i.type === 'assistant')).toEqual([expect.objectContaining({ text: 'done: pretended to delete demo.txt' })])
    expect(pushes.some((p) => p.kind === 'items' && p.items.some((i) => i.type === 'assistant' && i.text.trim() === ''))).toBe(false)
    // The resumed run sends the empty message back as the server sent it: the parent of its call.
    const [, two] = f.requests()
    expect(two.body.messages.at(-1)).toEqual({
      id: 'm0',
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'delete_demo_file', arguments: '{"path":"demo.txt"}' } }]
    })
    expect(two.body.resume).toEqual([{ interruptId: 'int-call_1', status: 'resolved', payload: { approved: true } }])
  }, 20_000)

  it('Stop with a card open sends nothing more; the next send cancels the interrupt on the same thread (Review Focus 4)', async () => {
    script([interrupt(approval('int-1'))], [{ text: 'Cancelled.' }, { finish: {} }])
    const c = await store.create('rem', dir)
    const turn = svc.send(c.id, 'deploy it')
    await pendingCard(c.id)
    svc.stop(c.id)
    await turn
    expect(f.requests()).toHaveLength(1)
    expect((await itemsOf(c.id)).find((i) => i.type === 'approval')).toMatchObject({ status: 'unanswered' })
    expect((await store.loadAgui(c.id))?.interrupts).toEqual([{ id: 'int-1', expiresAt: null }])
    await svc.send(c.id, 'never mind')
    const [one, two] = f.requests()
    expect(two.body.threadId).toBe(one.body.threadId)
    expect(two.body.resume).toEqual([{ interruptId: 'int-1', status: 'cancelled' }])
    expect((await store.loadAgui(c.id))?.interrupts).toEqual([])
  }, 20_000)

  describe('nothing local', () => {
    it('no bridge, no system text (house style, a workflow paragraph) and no board note; only the messages go', async () => {
      const made = { todo: vi.fn(), vault: vi.fn(), ask: vi.fn(), browser: vi.fn(), proc: vi.fn(), note: vi.fn() }
      const bridge = { mcp: NO_MCP, args: [], env: { ZUMIBOT_TODOS_CAPABILITY: 'cap' }, prompt: 'Browser prompt', dispose: () => {} }
      svc = makeService({
        houseStyle: async () => true,
        todoTurns: {
          create: (o) => {
            made.todo(o)
            return bridge
          }
        },
        vaultTurns: {
          create: (o) => {
            made.vault(o)
            return bridge
          }
        },
        askTurns: {
          create: (o) => {
            made.ask(o)
            return bridge
          }
        },
        askRoster: async () => [{ name: 'b', description: 'x' }],
        browserTurns: {
          profileId: async () => 'p',
          create: async (o) => {
            made.browser(o)
            return { ...bridge, dispose: async () => {} }
          }
        },
        processTurns: {
          create: (o) => {
            made.proc(o)
            return bridge
          }
        },
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
      const c = await store.create('rem', dir)
      await store.update(c.id, { workflow: { workflowId: 'w', runId: 'r', stepId: 's', name: 'Flow' } })
      await svc.send(c.id, 'hi')
      for (const fn of Object.values(made)) expect(fn).not.toHaveBeenCalled()
      const [req] = f.requests()
      expect(req.body.messages.map((m: { role: string }) => m.role)).toEqual(['user'])
      expect(req.body.messages[0].content).toBe('hi')
      expect(req.body).toMatchObject({ tools: [], context: [], forwardedProps: {} })
      // No run paragraph either: a remote agent cannot hand a command to this machine's user.
      expect(JSON.stringify(req.body)).not.toContain(RUN_SYSTEM)
      expect(await svc.canPause(c.id)).toBe(false)
    }, 20_000)
  })

  it('deleting a chat removes its agui.json', async () => {
    const c = await store.create('rem', dir)
    await svc.send(c.id, 'hi')
    const file = join(dir, 'chats', `${c.id}.agui.json`)
    expect(existsSync(file)).toBe(true)
    await store.remove(c.id)
    expect(existsSync(file)).toBe(false)
  }, 20_000)
})

describe('isolation and the audit log for a remote agent', () => {
  it('a remote agent set to an isolation level is refused before any request, never run as Off', async () => {
    svc = makeService({
      isolation: {
        levelOf: () => 'container',
        runFor: async () => ({ level: 'container', refused: isolationRefusal('ag-ui', 'container') })
      }
    })
    const c = await store.create('rem', dir)
    await svc.send(c.id, 'hi')
    expect(f.requests()).toHaveLength(0)
    expect(await lastError(c.id)).toMatchObject({ text: isolationRefusal('ag-ui', 'container') })
  })

  it("its tool rows are audited as run on the remote server; a row its question card approved keeps the user's answer; no key value", async () => {
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
    script(
      [
        { tool: { id: 'call_0', name: 'search', args: { q: KEY } } },
        { raw: { type: 'TOOL_CALL_RESULT', messageId: 'r0', toolCallId: 'call_0', content: 'found', role: 'tool' } },
        { tool: { id: 'call_1', name: 'delete_demo_file', args: { path: 'demo.txt' } } },
        interrupt(approval('int-call_1', { toolCallId: 'call_1' }))
      ],
      [
        { raw: { type: 'TOOL_CALL_RESULT', messageId: 'r1', toolCallId: 'call_1', content: 'pretended to delete demo.txt', role: 'tool' } },
        { text: 'done' },
        { finish: {} }
      ]
    )
    const c = await store.create('rem', dir)
    const turn = svc.send(c.id, 'go')
    const card = await pendingCard(c.id)
    const q = (card.input as { questions: { question: string }[] }).questions[0]
    svc.answerQuestions(c.id, card.id, { [q.question]: 'Yes' })
    await turn
    expect(records.map((r) => [r.engine, r.tool, r.decision.kind, r.outcome])).toEqual([
      ['ag-ui', AGUI_TOOL, 'ranRemotely', 'ok'],
      ['ag-ui', AGUI_TOOL, 'approvedByUser', 'ok']
    ])
    expect(JSON.stringify(records)).not.toContain(KEY)
  }, 20_000)
})

describe("/todo and an agent without ZumiBot's to-do tools", () => {
  const refusal = todoRefusal('ag-ui', 'rem')
  const history = async (id: string) => {
    await store.saveItems(id, [
      { type: 'user', id: 'u1', text: '/todo plan the day', ts: 1, todo: true },
      { type: 'assistant', id: 'a1', text: 'ok', ts: 2 }
    ] as ChatItem[])
  }

  it("a resend of a /todo message is refused before any run, as the turn's error, and the chat keeps its items", async () => {
    const c = await store.create('rem', dir)
    await history(c.id)
    await svc.rerun(c.id, 'u1', null)
    expect(calls).toHaveLength(0)
    expect(claudeRun).not.toHaveBeenCalled()
    expect((await lastError(c.id))?.text).toContain(refusal)
    expect(kinds(await itemsOf(c.id))).toEqual(['user', 'assistant', 'error'])
    expect((await store.get(c.id))?.inFlight).toBe(false)
  })

  it('a send that arrives with the flag, or with a command that makes to-dos (a routine or workflow step), is refused the same way', async () => {
    const c = await store.create('rem', dir)
    await svc.send(c.id, '/todo plan', [], undefined, undefined, undefined, true)
    await svc.send(c.id, '/day', [], undefined, undefined, { agent: 'rem', name: 'day', prompt: 'Plan the day', todos: true })
    expect(calls).toHaveLength(0)
    expect((await itemsOf(c.id)).filter((i) => i.type === 'error').map((i) => (i as { text: string }).text)).toEqual([refusal, refusal])
    expect((await itemsOf(c.id)).some((i) => i.type === 'user')).toBe(false)
  })

  it('a plain message, and a command without the flag, still run', async () => {
    const c = await store.create('rem', dir)
    await svc.send(c.id, 'hi')
    await svc.send(c.id, '/check', [], undefined, undefined, { agent: 'rem', name: 'check', prompt: 'Check it' })
    expect(calls.length).toBeGreaterThan(0)
    expect((await itemsOf(c.id)).some((i) => i.type === 'error' && i.text.includes(refusal))).toBe(false)
  })
})
