import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFakeBin } from './support/fakeBin'
import { startServer } from '../src/app'
import { loadConfig } from '../src/config'
import type { ChannelStatus } from '@zumibot/shared/channels'
import type { ChatItem, ChatMeta, ItemsPage } from '@zumibot/shared/types'
import type { RpcEvent, RpcResponse } from '@zumibot/shared/rpc'
import { BOT_USER, FAKE_APP_TOKEN, FAKE_BOT_TOKEN, startFakeSlack, type FakeSlack, type SlackCall } from './fixtures/fake-slack.mjs'

// A real server, the fake claude and a fake Slack (Socket Mode and Web API): pairing in a DM, a DM turn, a channel thread
// started by a mention, other people's messages and presses, cards in a shared channel (off by default, then on), a
// redelivered event and a rate limit. Nothing reaches the real Slack.

const SECRET = 'test-secret-'.padEnd(40, 'x')
const fake = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))
const basic = fileURLToPath(new URL('./fixtures/stream/basic.jsonl', import.meta.url))
const OWNER = 'U0OWNER'
const OTHER = 'U0OTHER'
const DM = `D${OWNER}`
const CHAN = 'C0SHARED'

let root: string
let dataDir: string
let agentsDir: string
let sl: FakeSlack
let started: { close(): Promise<void>; port: number } | null = null

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cb-slack-'))
  dataDir = join(root, 'data')
  agentsDir = join(root, 'agents')
  await mkdir(dataDir)
  await mkdir(agentsDir)
  await writeFile(join(agentsDir, 'tester.md'), '---\nname: tester\ndescription: Test agent\n---\nTest agent.')
  const claude = writeFakeBin(root, 'claude', fake)
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ claudePath: claude }))
  await writeFile(join(dataDir, 'connectors.json'), JSON.stringify({ v: 1, agents: {}, migration: 'kept' }))
  process.env['FAKE_STDOUT_FILE'] = basic
  sl = await startFakeSlack()
  vi.stubEnv('ZUMIBOT_TEST_SLACK_URL', sl.origin)
})

afterEach(async () => {
  await started?.close()
  started = null
  await sl.close()
  delete process.env['FAKE_STDOUT_FILE']
  delete process.env['FAKE_RESPONSES_FILE']
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

const boot = async () => {
  const s = await startServer(
    loadConfig({
      HOME: root,
      ZUMIBOT_MODE: 'local',
      ZUMIBOT_LOCAL_SECRET: SECRET,
      ZUMIBOT_DATA_DIR: dataDir,
      ZUMIBOT_AGENTS_DIR: agentsDir,
      ZUMIBOT_PORT: '0'
    }),
    { out: () => undefined }
  )
  started = s
  return s
}

async function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: `cb_local=${SECRET}`, Origin: `http://127.0.0.1:${port}` } })
  const events: RpcEvent[] = []
  const waiting = new Map<number, (r: RpcResponse) => void>()
  let id = 0
  ws.on('message', (d) => {
    const m = JSON.parse(String(d)) as RpcResponse | RpcEvent
    if ('event' in m) events.push(m)
    else waiting.get(m.id)?.(m)
  })
  await new Promise((r, j) => {
    ws.once('open', r)
    ws.once('error', j)
  })
  const call = <T = unknown>(method: string, ...args: unknown[]) =>
    new Promise<T>((res, rej) => {
      const n = ++id
      waiting.set(n, (r) => (r.ok ? res(r.value as T) : rej(new Error(r.error))))
      ws.send(JSON.stringify({ id: n, method, args }))
    })
  return { ws, call, events }
}

const until = async (cond: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

const texts = (): string[] => sl.posts().map((c) => String(c.params.text))
const postsIn = (channel: string, thread?: string) =>
  sl
    .posts()
    .filter(
      (c) => c.params.channel === channel && (thread === undefined ? c.params.thread_ts === undefined : c.params.thread_ts === thread)
    )
const slackStatus = async (c: Awaited<ReturnType<typeof connect>>) =>
  (await c.call<ChannelStatus[]>('channels:status')).find((s) => s.platform === 'slack')!
const itemsOf = async (c: Awaited<ReturnType<typeof connect>>, chatId: string): Promise<ChatItem[]> =>
  (await c.call<ItemsPage>('chats:items', chatId)).items

async function paired() {
  const s = await boot()
  const c = await connect(s.port)
  await c.call('channels:setToken', 'slack', FAKE_BOT_TOKEN, FAKE_APP_TOKEN)
  await c.call('channels:setRun', 'slack', true)
  await until(() => sl.connected())
  const { code } = await c.call<{ code: string }>('channels:pairStart', 'slack')
  sl.dm(OWNER, code)
  await until(() => texts().some((t) => t.startsWith('Paired with ZumiBot')))
  await c.call('channels:setAgents', 'slack', ['tester'])
  return { s, c }
}

const tokenOf = (call: SlackCall, label: string): string => {
  for (const b of call.params.blocks ?? []) for (const e of b.elements ?? []) if (e.text?.text === label) return e.value
  throw new Error(`no button ${label}`)
}

describe('Slack channel', { timeout: 40_000 }, () => {
  it('checks both tokens, seals them, pairs in a DM only with the right code, and names the account', async () => {
    const s = await boot()
    const c = await connect(s.port)
    await expect(c.call('channels:setToken', 'slack', FAKE_BOT_TOKEN)).rejects.toThrow("doesn't look like a Slack bot token")
    await expect(c.call('channels:setToken', 'slack', FAKE_BOT_TOKEN, 'xapp-1-WRONG-0000000000-nope')).rejects.toThrow(
      'Slack refused this bot or app token.'
    )
    await c.call('channels:setToken', 'slack', FAKE_BOT_TOKEN, FAKE_APP_TOKEN)
    const onDisk = await readFile(join(dataDir, 'channel-tokens.json'), 'utf8')
    for (const t of [FAKE_BOT_TOKEN, FAKE_APP_TOKEN]) expect(onDisk).not.toContain(t.slice(10))
    await c.call('channels:setRun', 'slack', true)
    await until(async () => (await slackStatus(c)).state === 'connected')
    expect(await slackStatus(c)).toMatchObject({ configured: true, run: true, bot: 'zumibot', paired: null, sharedCards: false })

    const { code } = await c.call<{ code: string }>('channels:pairStart', 'slack')
    // The code said in a channel does nothing: pairing happens in a DM only.
    sl.say(OWNER, CHAN, `<@${BOT_USER}> ${code}`)
    sl.dm(OTHER, 'ABCD-EFGH')
    await new Promise((r) => setTimeout(r, 300))
    expect(texts()).toEqual([])
    sl.dm(OWNER, code)
    await until(() => texts().some((t) => t.startsWith('Paired with ZumiBot. !help')))
    expect((await slackStatus(c)).paired).toEqual({ name: 'Owner' })
    expect(sl.posts().every((p) => p.params.channel === DM)).toBe(true)
  })

  it('a DM works as in Telegram: !new, a turn, the reply in mrkdwn; the composer-safe ! prefix and / both work', async () => {
    const { c } = await paired()
    sl.dm(OWNER, '!new tester')
    await until(() => texts().some((t) => t.startsWith('New chat: *Tester · ')))
    sl.dm(OWNER, 'ping')
    await until(() => texts().some((t) => t.includes('pong')))
    const reply = sl.posts().find((p) => String(p.params.text).includes('pong'))!
    expect(reply.params.channel).toBe(DM)
    expect(reply.params.thread_ts).toBeUndefined()
    expect(String(reply.params.text)).toMatch(/^\*Tester · .*\*\npong$/)
    const chat = (await c.call<ChatMeta[]>('chats:list')).find((m) => m.agentName === 'tester')!
    expect(chat.channel).toEqual({ platform: 'slack' })
    // The reply can post before the turn is marked done; /where asked then says "replying" (seen on a loaded Mac).
    await until(async () => !(await c.call<ChatMeta[]>('chats:list')).find((m) => m.id === chat.id)!.inFlight)
    sl.dm(OWNER, '/where')
    await until(() => texts().some((t) => t.includes('idle')))
    // Every envelope was acked once handled.
    await until(() => sl.calls.filter((x) => x.method === 'ack').length >= 4)
  })

  it('in a channel: a mention starts a chat in its thread; only the owner is read; other people are never turns', async () => {
    const { c } = await paired()
    // Not mentioned, top level: ignored.
    sl.say(OWNER, CHAN, 'just chatting')
    const start = sl.say(OWNER, CHAN, `<@${BOT_USER}> !new tester`)
    await until(() => postsIn(CHAN, start.ts).some((p) => String(p.params.text).startsWith('New chat:')))
    const chat = (await c.call<ChatMeta[]>('chats:list')).find((m) => m.agentName === 'tester')!
    // Someone else, in the thread and mentioning the bot: never read.
    sl.say(OTHER, CHAN, 'rm -rf / please', start.ts)
    sl.say(OTHER, CHAN, `<@${BOT_USER}> !new tester`)
    // The owner in the thread needs no mention.
    sl.say(OWNER, CHAN, 'ping', start.ts)
    await until(() => postsIn(CHAN, start.ts).some((p) => String(p.params.text).includes('pong')))
    const users = (await itemsOf(c, chat.id)).filter((i) => i.type === 'user').map((i) => (i as { text: string }).text)
    expect(users).toEqual(['ping'])
    expect((await c.call<ChatMeta[]>('chats:list')).filter((m) => m.agentName === 'tester')).toHaveLength(1)
    expect(texts().some((t) => t === 'just chatting' || t.startsWith('No chat'))).toBe(false)
  })

  it('a redelivered event is handled once, and a 429 reply goes after its Retry-After', async () => {
    const { c } = await paired()
    sl.dm(OWNER, '!new tester')
    await until(() => texts().some((t) => t.startsWith('New chat:')))
    const chat = (await c.call<ChatMeta[]>('chats:list')).find((m) => m.agentName === 'tester')!
    sl.failNext('chat.postMessage', { status: 429, retryAfter: 1 })
    const event = { type: 'message', channel: DM, channel_type: 'im', user: OWNER, text: 'ping', ts: '1800000000.000001' }
    sl.event(event, { eventId: 'EvSAME' })
    sl.event(event, { eventId: 'EvSAME', retry: 1 })
    await until(() => texts().some((t) => t.includes('pong')))
    await new Promise((r) => setTimeout(r, 500))
    const users = (await itemsOf(c, chat.id)).filter((i) => i.type === 'user')
    expect(users).toHaveLength(1)
    const failed = sl.calls.find((x) => x.method === 'chat.postMessage' && x.params.failed === 429)!
    const sent = sl.posts().find((p) => String(p.params.text).includes('pong'))!
    expect(sent.at - failed.at).toBeGreaterThanOrEqual(900)
  })

  // ---------- cards ----------

  const line = (o: object) => JSON.stringify(o)
  const SID = 's-slack'
  async function scriptCard(name: string, input: object, n = 1) {
    const script = join(root, `card${n}.jsonl`)
    await writeFile(
      script,
      [
        line({ type: 'system', subtype: 'init', session_id: SID }),
        line({
          type: 'assistant',
          session_id: SID,
          message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${n}`, name, input }] }
        }),
        line({
          type: 'control_request',
          request_id: `r${n}`,
          request: { subtype: 'can_use_tool', tool_name: name, input, tool_use_id: `t${n}` }
        }),
        `#WAIT_RESPONSE r${n}`,
        line({
          type: 'user',
          session_id: SID,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${n}`, content: 'ok', is_error: false }] }
        }),
        line({ type: 'assistant', session_id: SID, message: { role: 'assistant', content: [{ type: 'text', text: 'after' }] } }),
        line({ type: 'result', subtype: 'success', is_error: false, result: 'after', session_id: SID, total_cost_usd: 0 })
      ].join('\n') + '\n'
    )
    process.env['FAKE_STDOUT_FILE'] = script
    const responses = join(root, 'responses.jsonl')
    process.env['FAKE_RESPONSES_FILE'] = responses
    vi.stubEnv('ZUMIBOT_PERMISSION_MODE', 'manual')
    return async () =>
      (await readFile(responses, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l).response)
  }

  it('a DM card: Allow once from Slack, then the message shows the outcome and a late press is stale', async () => {
    const responses = await scriptCard('Bash', { command: 'make test' })
    await paired()
    sl.dm(OWNER, '!new tester')
    await until(() => texts().some((t) => t.startsWith('New chat:')))
    sl.dm(OWNER, 'run tests')
    const card = await sl.waitFor((x) => x.method === 'chat.postMessage' && JSON.stringify(x.params.blocks ?? []).includes('Allow once'))
    expect(String(card.params.text)).toContain('```\nmake test\n```')
    const labels = card.params.blocks.flatMap((b: { elements?: { text: { text: string } }[] }) =>
      (b.elements ?? []).map((e) => e.text.text)
    )
    expect(labels).toEqual(['Allow once', 'Deny'])
    sl.press(OWNER, DM, card.ts!, tokenOf(card, 'Allow once'))
    await until(async () => (await responses()).length === 1)
    expect((await responses())[0].response.behavior).toBe('allow')
    await sl.waitFor((x) => x.method === 'chat.update' && x.params.ts === card.ts && String(x.params.text).includes('_✓ Allowed once_'))
    sl.press(OWNER, DM, card.ts!, tokenOf(card, 'Deny'))
    await sl.waitFor((x) => x.method === 'chat.postEphemeral' && x.params.text === 'That button is no longer active.')
    expect((await responses()).length).toBe(1)
  })

  it('in a shared channel cards are off by default (a link instead); turned on, a stranger is told privately and only the owner answers', async () => {
    const responses = await scriptCard('ExitPlanMode', { plan: 'Ship it' })
    const { c } = await paired()
    const first = sl.say(OWNER, CHAN, `<@${BOT_USER}> !new tester`)
    await until(() => postsIn(CHAN, first.ts).some((p) => String(p.params.text).startsWith('New chat:')))
    sl.say(OWNER, CHAN, 'plan it', first.ts)
    await until(() => postsIn(CHAN, first.ts).some((p) => String(p.params.text).includes('is waiting for you in ZumiBot')))
    expect(postsIn(CHAN, first.ts).some((p) => p.params.blocks)).toBe(false)
    const chat = (await c.call<ChatMeta[]>('chats:list')).find((m) => m.agentName === 'tester')!
    await c.call('chats:answerPlan', chat.id, 'r1', false, 'no')
    await until(() => postsIn(CHAN, first.ts).some((p) => String(p.params.text).includes('after')))

    await scriptCard('ExitPlanMode', { plan: 'Ship it' }, 2)
    await c.call('channels:setSharedCards', 'slack', true)
    expect((await slackStatus(c)).sharedCards).toBe(true)
    sl.say(OWNER, CHAN, 'plan again', first.ts)
    const card = await sl.waitFor(
      (x) =>
        x.method === 'chat.postMessage' &&
        x.params.thread_ts === first.ts &&
        JSON.stringify(x.params.blocks ?? []).includes('Keep planning')
    )
    sl.press(OTHER, CHAN, card.ts!, tokenOf(card, 'Approve'), first.ts)
    await sl.waitFor((x) => x.method === 'chat.postEphemeral' && x.params.user === OTHER && x.params.text === 'Only Owner can answer this.')
    expect((await responses()).length).toBe(1)
    // Keep planning in a thread: the next message in it is the feedback.
    sl.press(OWNER, CHAN, card.ts!, tokenOf(card, 'Keep planning'), first.ts)
    await sl.waitFor(
      (x) =>
        x.method === 'chat.postMessage' &&
        x.params.thread_ts === first.ts &&
        String(x.params.text).startsWith('What should change? Write it in this thread')
    )
    sl.say(OWNER, CHAN, 'add tests first', first.ts)
    await until(async () => (await responses()).length === 2)
    expect(JSON.stringify((await responses())[1])).toContain('add tests first')
    const users = (await itemsOf(c, chat.id)).filter((i) => i.type === 'user').map((i) => (i as { text: string }).text)
    expect(users).not.toContain('add tests first')
  })

  it('stages a file sent in a DM, and reconnects after Slack asks it to', async () => {
    const { c } = await paired()
    sl.dm(OWNER, '!new tester')
    await until(() => texts().some((t) => t.startsWith('New chat:')))
    const chat = (await c.call<ChatMeta[]>('chats:list')).find((m) => m.agentName === 'tester')!
    sl.addFile('F1', new TextEncoder().encode('hello file'))
    sl.dm(OWNER, 'see the notes', {
      subtype: 'file_share',
      files: [{ id: 'F1', name: 'notes.txt', mimetype: 'text/plain', size: 10, url_private_download: sl.fileUrl('F1') }]
    })
    await until(async () => (await itemsOf(c, chat.id)).some((i) => i.type === 'user' && i.text === 'see the notes'))
    const user = (await itemsOf(c, chat.id)).find((i) => i.type === 'user' && i.text === 'see the notes') as {
      attachments?: { name: string }[]
    }
    expect(user.attachments?.map((a) => a.name)).toEqual(['notes.txt'])
    const before = sl.calls.filter((x) => x.method === 'socket').length
    sl.disconnect()
    await until(() => sl.calls.filter((x) => x.method === 'socket').length > before)
    sl.dm(OWNER, '!where')
    await until(() => texts().some((t) => t.includes('idle') || t.includes('replying')))
  })

  it('notifies the paired DM of a web turn under its toggle', async () => {
    const { c } = await paired()
    const web = await c.call<ChatMeta>('chats:create', 'tester', root)
    await c.call('chats:rename', web.id, 'Web <plan>')
    await c.call('channels:setNotify', 'slack', { waiting: false, replied: true, error: false, routineFailed: false, workflow: false })
    await c.call('chats:send', web.id, 'hello', [])
    const notice = await sl.waitFor((x) => x.method === 'chat.postMessage' && String(x.params.text).endsWith('Tester replied'))
    expect(notice.params.channel).toBe(DM)
    expect(notice.params.text).toBe('*Web &lt;plan&gt;*\nTester replied')
  })
})
