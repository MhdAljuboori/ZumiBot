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
import { FAKE_TOKEN, startFakeTelegram, type FakeTelegram } from './fixtures/fake-telegram.mjs'

// A real server, the fake claude and a fake Telegram: pairing, a turn, a stranger, a redelivered update, a rate limit and
// a restart mid-reply. Nothing reaches the real Telegram.

const SECRET = 'test-secret-'.padEnd(40, 'x')
const fake = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))
const basic = fileURLToPath(new URL('./fixtures/stream/basic.jsonl', import.meta.url))
const OWNER = 1001
const STRANGER = 2002

let root: string
let dataDir: string
let agentsDir: string
let tg: FakeTelegram
let started: { close(): Promise<void>; port: number } | null = null

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cb-channels-'))
  dataDir = join(root, 'data')
  agentsDir = join(root, 'agents')
  await mkdir(dataDir)
  await mkdir(agentsDir)
  await writeFile(join(agentsDir, 'tester.md'), '---\nname: tester\ndescription: Test agent\n---\nTest agent.')
  await writeFile(join(agentsDir, 'other.md'), '---\nname: other\ndescription: Other agent\n---\nOther agent.')
  const claude = writeFakeBin(root, 'claude', fake)
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ claudePath: claude }))
  await writeFile(join(dataDir, 'connectors.json'), JSON.stringify({ v: 1, agents: {}, migration: 'kept' }))
  process.env['FAKE_STDOUT_FILE'] = basic
  tg = await startFakeTelegram()
  vi.stubEnv('ZUMIBOT_TEST_TELEGRAM_URL', tg.origin)
})

afterEach(async () => {
  await started?.close()
  started = null
  await tg.close()
  delete process.env['FAKE_STDOUT_FILE']
  delete process.env['FAKE_HANG']
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

const texts = () => tg.sent().map((p) => String(p.text))

/** A server with the token saved, the bot running here and the owner paired; `tester` on for Telegram. */
async function paired() {
  const s = await boot()
  const c = await connect(s.port)
  await c.call('channels:setToken', 'telegram', FAKE_TOKEN)
  await c.call('channels:setRun', 'telegram', true)
  const { code } = await c.call<{ code: string }>('channels:pairStart', 'telegram')
  tg.message(OWNER, code)
  await until(() => texts().some((t) => t.startsWith('Paired with ZumiBot')))
  await c.call('channels:setAgents', 'telegram', ['tester'])
  return { s, c }
}

async function itemsOf(c: Awaited<ReturnType<typeof connect>>, chatId: string): Promise<ChatItem[]> {
  return (await c.call<ItemsPage>('chats:items', chatId)).items
}

describe('Telegram channel', { timeout: 40_000 }, () => {
  it('stores the token sealed, never in a readable file, and pairs only with the right code', async () => {
    const s = await boot()
    const c = await connect(s.port)
    await expect(c.call('channels:setToken', 'telegram', 'not a token')).rejects.toThrow("doesn't look like a Telegram bot token")
    await expect(c.call('channels:setToken', 'telegram', '999:' + 'B'.repeat(40))).rejects.toThrow('Telegram refused this bot token.')
    await c.call('channels:setToken', 'telegram', FAKE_TOKEN)
    const onDisk = await readFile(join(dataDir, 'channel-tokens.json'), 'utf8')
    expect(onDisk).not.toContain(FAKE_TOKEN)
    expect(onDisk).not.toContain(FAKE_TOKEN.split(':')[1])
    await c.call('channels:setRun', 'telegram', true)
    await until(async () => (await c.call<ChannelStatus[]>('channels:status'))[0].state === 'connected')
    const [st] = await c.call<ChannelStatus[]>('channels:status')
    expect(st).toMatchObject({ configured: true, run: true, bot: 'test_zumibot', paired: null })
    expect(JSON.stringify(st)).not.toContain(FAKE_TOKEN)

    const { code } = await c.call<{ code: string }>('channels:pairStart', 'telegram')
    tg.message(STRANGER, 'hello?')
    tg.message(STRANGER, 'ABCD-EFGH')
    const strangerTry = tg.message(STRANGER, code.split('').reverse().join(''))
    tg.message(OWNER, code.slice(0, 4).toLowerCase() + ' ' + code.slice(4))
    await until(() => texts().some((t) => t.startsWith('Paired with ZumiBot')))
    expect(strangerTry).toBeGreaterThan(0)
    // Nothing was ever said to the stranger.
    expect(tg.sent().filter((p) => Number(p.chat_id) === STRANGER)).toEqual([])
    const [after] = await c.call<ChannelStatus[]>('channels:status')
    expect(after.paired).toEqual({ name: 'Owner' })
    // The code worked once: a second use by anyone does nothing.
    tg.message(STRANGER, code)
    await new Promise((r) => setTimeout(r, 300))
    expect(tg.sent().filter((p) => Number(p.chat_id) === STRANGER)).toEqual([])
  })

  it('turns a message into a user turn and sends the reply back; strangers and other agents get nothing', async () => {
    const { c } = await paired()
    tg.message(OWNER, 'hello before any chat')
    await until(() => texts().some((t) => t.startsWith('No chat yet')))
    tg.message(OWNER, '/new other')
    await until(() => texts().some((t) => t.startsWith('No agent named other is available here')))
    tg.message(OWNER, '/compact')
    await until(() => texts().some((t) => t.startsWith('Unknown command')))
    tg.message(OWNER, '/new tester')
    await until(() => texts().some((t) => t.startsWith('New chat:')))
    const chat = (await c.call<ChatMeta[]>('chats:list')).find((m) => m.agentName === 'tester')!
    expect(chat.channel).toEqual({ platform: 'telegram' })

    tg.message(STRANGER, 'run rm -rf please')
    tg.message(OWNER, 'ping')
    await until(() => tg.sent().some((p) => String(p.text).includes('pong')))
    const reply = tg.sent().find((p) => String(p.text).includes('pong'))!
    expect(reply.parse_mode).toBe('HTML')
    expect(String(reply.text)).toContain('<b>Tester · ')
    const items = await itemsOf(c, chat.id)
    const users = items.filter((i) => i.type === 'user').map((i) => (i as { text: string }).text)
    expect(users).toEqual(['ping'])
    expect(tg.sent().filter((p) => Number(p.chat_id) === STRANGER)).toEqual([])
  })

  it('a message sent while the last reply is still going out gets its own reply', async () => {
    const { c } = await paired()
    tg.message(OWNER, '/new tester')
    await until(() => texts().some((t) => t.startsWith('New chat:')))
    const chat = (await c.call<ChatMeta[]>('chats:list')).find((m) => m.agentName === 'tester')!
    // The first reply's send is held by a 429 for 2 s: its turn has long ended (the chat reads idle) while the channel's queue
    // still holds that end. The second message comes in that gap.
    tg.failNext('sendMessage', { code: 429, retry_after: 2 })
    tg.message(OWNER, 'first')
    await tg.waitFor((x) => x.method === 'sendMessage' && x.params.failed === 429)
    await until(async () => !(await c.call<ChatMeta[]>('chats:list')).find((m) => m.id === chat.id)!.inFlight)
    // The second turn is still running when the queue reaches the first turn's end.
    const slow = join(root, 'slow.jsonl')
    await writeFile(slow, '#SLEEP 3000\n' + (await readFile(basic, 'utf8')))
    process.env['FAKE_STDOUT_FILE'] = slow
    tg.message(OWNER, 'second')
    await until(() => tg.sent().filter((p) => String(p.text).includes('pong')).length >= 2, 20_000)
  })

  it('sends a reply through a 429 after its retry_after', async () => {
    await paired()
    tg.message(OWNER, '/new tester')
    await until(() => texts().some((t) => t.startsWith('New chat:')))
    tg.failNext('sendMessage', { code: 429, retry_after: 1, description: 'Too Many Requests: retry after 1' })
    tg.message(OWNER, 'ping')
    await until(() => tg.sent().some((p) => String(p.text).includes('pong')))
    const failed = tg.calls.find((x) => x.method === 'sendMessage' && x.params.failed === 429)!
    const delivered = tg.calls.find((x) => x.method === 'sendMessage' && String(x.params.text).includes('pong') && !x.params.failed)!
    expect(delivered.at - failed.at).toBeGreaterThanOrEqual(900)
  })

  it('neither replays nor drops an update across a restart, even when its offset was not saved', async () => {
    const { s, c } = await paired()
    tg.message(OWNER, '/new tester')
    await until(() => texts().some((t) => t.startsWith('New chat:')))
    const pingId = tg.message(OWNER, 'ping')
    await until(() => tg.sent().some((p) => String(p.text).includes('pong')))
    const chat = (await c.call<ChatMeta[]>('chats:list')).find((m) => m.agentName === 'tester')!
    c.ws.close()
    await s.close()
    started = null
    // As if the server died after the turn started and before the offset was written: that update comes again. The /new
    // before it comes again too, as if its command record were the only thing written.
    const statePath = join(dataDir, 'channel-state.json')
    const st = JSON.parse(await readFile(statePath, 'utf8'))
    st.telegram.offset = pingId - 1
    await writeFile(statePath, JSON.stringify(st))
    const before = tg.sent().length
    const s2 = await boot()
    const c2 = await connect(s2.port)
    tg.message(OWNER, 'second')
    await until(async () => (await itemsOf(c2, chat.id)).filter((i) => i.type === 'user').length >= 2)
    await until(
      () =>
        tg
          .sent()
          .slice(before)
          .filter((p) => String(p.text).includes('pong')).length >= 1
    )
    const users = (await itemsOf(c2, chat.id)).filter((i) => i.type === 'user').map((i) => (i as { text: string }).text)
    expect(users).toEqual(['ping', 'second'])
    expect((await c2.call<ChatMeta[]>('chats:list')).filter((m) => m.agentName === 'tester')).toHaveLength(1)
  })

  it('says a reply was cut when the server restarted mid-reply', async () => {
    const { s, c } = await paired()
    tg.message(OWNER, '/new tester')
    await until(() => texts().some((t) => t.startsWith('New chat:')))
    process.env['FAKE_HANG'] = '1'
    tg.message(OWNER, 'long job')
    await until(async () => (await c.call<ChatMeta[]>('chats:list')).some((m) => m.agentName === 'tester' && m.inFlight))
    c.ws.close()
    await s.close()
    started = null
    delete process.env['FAKE_HANG']
    await boot()
    await until(() => texts().some((t) => t.startsWith('(Interrupted: ZumiBot restarted')))
  })

  it('stages a file as an attachment and answers a voice note while voice input is off', async () => {
    const { c } = await paired()
    tg.message(OWNER, '/new tester')
    await until(() => texts().some((t) => t.startsWith('New chat:')))
    const chat = (await c.call<ChatMeta[]>('chats:list')).find((m) => m.agentName === 'tester')!
    tg.addFile('doc1', new TextEncoder().encode('hello file'))
    tg.message(OWNER, '', {
      text: undefined,
      caption: 'see the notes',
      document: { file_id: 'doc1', file_name: 'notes.txt', mime_type: 'text/plain', file_size: 10 }
    })
    await until(async () => (await itemsOf(c, chat.id)).some((i) => i.type === 'user' && i.text === 'see the notes'))
    const user = (await itemsOf(c, chat.id)).find((i) => i.type === 'user' && i.text === 'see the notes') as {
      attachments?: { name: string; size: number }[]
    }
    expect(user.attachments?.map((a) => [a.name, a.size])).toEqual([['notes.txt', 10]])
    tg.addFile('v1', new Uint8Array([1, 2, 3]))
    tg.message(OWNER, '', { text: undefined, voice: { file_id: 'v1', duration: 1, mime_type: 'audio/ogg', file_size: 3 } })
    await until(() => texts().some((t) => t.startsWith('Voice input is off in ZumiBot')))
  })

  it('a press on a used or stranger button changes nothing', async () => {
    const { c } = await paired()
    tg.message(OWNER, '/agents')
    const list = await tg.waitFor((x) => x.method === 'sendMessage' && x.params.text === 'Start a new chat with:')
    const token = list.params.reply_markup.inline_keyboard[0][0].callback_data as string
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/)
    tg.press(STRANGER, 1, token)
    await tg.waitFor((x) => x.method === 'answerCallbackQuery')
    expect((await c.call<ChatMeta[]>('chats:list')).length).toBe(0)
    tg.press(OWNER, 1, token)
    await until(() => texts().some((t) => t.startsWith('New chat:')))
    tg.press(OWNER, 1, token)
    await tg.waitFor((x) => x.method === 'answerCallbackQuery' && x.params.text === 'That button is no longer active.')
    expect((await c.call<ChatMeta[]>('chats:list')).length).toBe(1)
  })

  // ---------- phase 2: cards ----------

  const line = (o: object) => JSON.stringify(o)
  const SID = 's-cards'
  const use = (id: string, name: string, input: object) =>
    line({ type: 'assistant', session_id: SID, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
  const ask = (req: string, id: string, name: string, input: object) =>
    line({ type: 'control_request', request_id: req, request: { subtype: 'can_use_tool', tool_name: name, input, tool_use_id: id } })
  const result = (id: string, content: string) =>
    line({
      type: 'user',
      session_id: SID,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: false }] }
    })
  const say = (text: string) =>
    line({ type: 'assistant', session_id: SID, message: { role: 'assistant', content: [{ type: 'text', text }] } })
  const end = (text: string) =>
    line({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: SID, total_cost_usd: 0 })

  /** One turn that asks `name` with `input` and waits for the answer, then says "after". */
  async function scriptCard(name: string, input: object) {
    const script = join(root, 'card.jsonl')
    await writeFile(
      script,
      [
        line({ type: 'system', subtype: 'init', session_id: SID }),
        use('t1', name, input),
        ask('r1', 't1', name, input),
        '#WAIT_RESPONSE r1',
        result('t1', 'ok'),
        say('after'),
        end('after')
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

  const cardMsg = (label: string) =>
    tg.waitFor((x) => x.method === 'sendMessage' && JSON.stringify(x.params.reply_markup ?? {}).includes(`"${label}"`))
  const tokenOf = (call: { params: any }, label: string): string => {
    for (const row of call.params.reply_markup.inline_keyboard)
      for (const b of row) if (b.text === label || b.text === `✓ ${label}`) return b.callback_data
    throw new Error(`no button ${label}`)
  }
  const startChat = async () => {
    const env = await paired()
    tg.message(OWNER, '/new tester')
    await until(() => texts().some((t) => t.startsWith('New chat:')))
    return env
  }

  it('an approval card offers Allow once and Deny only; a press answers it once, and the card shows the outcome', async () => {
    const responses = await scriptCard('Bash', { command: 'rm -rf build', description: 'Clean the build' })
    await startChat()
    tg.message(OWNER, 'clean up')
    const card = await cardMsg('Allow once')
    expect(String(card.params.text)).toContain('<pre>rm -rf build</pre>')
    const labels = card.params.reply_markup.inline_keyboard.flat().map((b: { text: string }) => b.text)
    expect(labels).toEqual(['Allow once', 'Deny'])
    // A stranger's press does nothing.
    tg.press(STRANGER, 1, tokenOf(card, 'Allow once'))
    await new Promise((r) => setTimeout(r, 300))
    expect(await responses()).toEqual([])
    tg.press(OWNER, 1, tokenOf(card, 'Allow once'))
    await until(async () => (await responses()).length === 1)
    expect((await responses())[0].response.behavior).toBe('allow')
    await tg.waitFor(
      (x) =>
        x.method === 'editMessageText' && String(x.params.text).includes('✓ Allowed once') && !String(x.params.text).includes('in ZumiBot')
    )
    tg.press(OWNER, 1, tokenOf(card, 'Deny'))
    await tg.waitFor((x) => x.method === 'answerCallbackQuery' && x.params.text === 'That button is no longer active.')
    await until(() => texts().some((t) => t.includes('after')))
    expect((await responses()).length).toBe(1)
  })

  it('a card answered in the web UI updates its message, and a late press there is stale', async () => {
    const responses = await scriptCard('Bash', { command: 'curl example.com' })
    const { c } = await startChat()
    tg.message(OWNER, 'fetch it')
    const card = await cardMsg('Deny')
    const chat = (await c.call<ChatMeta[]>('chats:list')).find((m) => m.agentName === 'tester')!
    await c.call('chats:answer', chat.id, 'r1', 'deny')
    await until(async () => (await responses()).length === 1)
    expect((await responses())[0].response.behavior).toBe('deny')
    await tg.waitFor((x) => x.method === 'editMessageText' && String(x.params.text).includes('✗ Denied in ZumiBot'))
    tg.press(OWNER, 1, tokenOf(card, 'Allow once'))
    await tg.waitFor((x) => x.method === 'answerCallbackQuery' && /no longer active|Already answered/.test(String(x.params.text)))
    expect((await responses()).length).toBe(1)
  })

  it('a question card: one pick, a multi-select with Done, and a typed answer, sent once all have answers', async () => {
    const input = {
      questions: [
        {
          question: 'Which color?',
          header: 'Color',
          multiSelect: false,
          options: [
            { label: 'Red', description: 'warm' },
            { label: 'Blue', description: 'cool' }
          ]
        },
        {
          question: 'Which sizes?',
          header: 'Size',
          multiSelect: true,
          options: [
            { label: 'S', description: '' },
            { label: 'M', description: '' },
            { label: 'L', description: '' }
          ]
        },
        { question: 'Any note?', header: 'Note', kind: 'text', options: [] }
      ]
    }
    const responses = await scriptCard('AskUserQuestion', input)
    await startChat()
    tg.message(OWNER, 'ask me')
    const q1 = await cardMsg('Blue')
    const q2 = await cardMsg('Done')
    const q3 = await cardMsg('Type an answer…')
    tg.press(OWNER, q1.messageId!, tokenOf(q1, 'Blue'))
    await tg.waitFor((x) => x.method === 'editMessageText' && String(x.params.text).includes('✓ Blue'))
    tg.press(OWNER, q2.messageId!, tokenOf(q2, 'S'))
    await tg.waitFor((x) => x.method === 'editMessageReplyMarkup' && JSON.stringify(x.params).includes('✓ S'))
    tg.press(OWNER, q2.messageId!, tokenOf(q2, 'L'))
    await tg.waitFor((x) => x.method === 'editMessageReplyMarkup' && JSON.stringify(x.params).includes('✓ L'))
    tg.press(OWNER, q2.messageId!, tokenOf(q2, 'Done'))
    await tg.waitFor((x) => x.method === 'editMessageText' && String(x.params.text).includes('✓ S, L'))
    expect(await responses()).toEqual([])
    tg.press(OWNER, q3.messageId!, tokenOf(q3, 'Type an answer…'))
    const prompt = await tg.waitFor((x) => x.method === 'sendMessage' && x.params.reply_markup?.force_reply === true)
    const promptId = prompt.messageId!
    tg.message(OWNER, 'ship by Friday', { reply_to_message: { message_id: promptId } })
    await until(async () => (await responses()).length === 1)
    const r = (await responses())[0].response
    expect(r.behavior).toBe('allow')
    expect(r.updatedInput.answers).toEqual({ 'Which color?': 'Blue', 'Which sizes?': ['S', 'L'], 'Any note?': 'ship by Friday' })
    await until(() => texts().some((t) => t.includes('after')))
    // The typed answer never became a turn.
    expect(texts().filter((t) => t.includes('Queued'))).toEqual([])
  })

  it('a plan card: Keep planning with feedback typed as a reply', async () => {
    const responses = await scriptCard('ExitPlanMode', { plan: '## Plan\n1. Do **this**\n2. Then that' })
    await startChat()
    tg.message(OWNER, 'plan it')
    const card = await cardMsg('Keep planning')
    expect(String(card.params.text)).toContain('<b>Plan for your approval</b>')
    expect(String(card.params.text)).toContain('1. Do <b>this</b>')
    tg.press(OWNER, 1, tokenOf(card, 'Keep planning'))
    const prompt = await tg.waitFor((x) => x.method === 'sendMessage' && x.params.reply_markup?.force_reply === true)
    const promptId = prompt.messageId!
    tg.message(OWNER, 'add tests first', { reply_to_message: { message_id: promptId } })
    await until(async () => (await responses()).length === 1)
    const r = (await responses())[0].response
    expect(r.behavior).toBe('deny')
    expect(JSON.stringify(r)).toContain('add tests first')
    await tg.waitFor(
      (x) =>
        x.method === 'editMessageText' &&
        String(x.params.text).includes('↩ Sent back to keep planning') &&
        !String(x.params.text).includes('in ZumiBot')
    )
  })

  it('a plan card: Approve', async () => {
    const responses = await scriptCard('ExitPlanMode', { plan: 'Just do it' })
    await startChat()
    tg.message(OWNER, 'plan it')
    const card = await cardMsg('Approve')
    tg.press(OWNER, 1, tokenOf(card, 'Approve'))
    await until(async () => (await responses()).length === 1)
    expect((await responses())[0].response.behavior).toBe('allow')
    await tg.waitFor((x) => x.method === 'editMessageText' && String(x.params.text).includes('✓ Plan approved'))
  })

  it('a restart while a card waits clears its buttons, and a press on it changes nothing', async () => {
    await scriptCard('Bash', { command: 'make deploy' })
    const { s, c } = await startChat()
    tg.message(OWNER, 'deploy')
    const card = await cardMsg('Allow once')
    c.ws.close()
    await s.close()

    started = null
    await boot()
    await tg.waitFor(
      (x) =>
        x.method === 'editMessageReplyMarkup' &&
        x.params.message_id === card.messageId &&
        JSON.stringify(x.params.reply_markup) === '{"inline_keyboard":[]}'
    )
    await until(() => texts().some((t) => t.startsWith('Cards from before ZumiBot restarted')))
    tg.press(OWNER, card.messageId!, tokenOf(card, 'Allow once'))
    await tg.waitFor((x) => x.method === 'answerCallbackQuery' && x.params.text === 'That button is no longer active.')
  })

  // ---------- phase 4: notifications ----------

  it('notifies the paired chat of a web turn only under its toggle, never twice for a channel turn, and a reply continues that chat', async () => {
    const { c } = await paired()
    const OFF = { waiting: false, replied: false, error: false, routineFailed: false, workflow: false }
    const web = await c.call<ChatMeta>('chats:create', 'tester', root)
    await c.call('chats:rename', web.id, 'Web plan')
    // Off (the default): a web turn tells Telegram nothing.
    await c.call('chats:send', web.id, 'first', [])
    await new Promise((r) => setTimeout(r, 400))
    expect(texts().filter((t) => t.includes('replied'))).toEqual([])
    await expect(c.call('channels:setNotify', 'telegram', { replied: true })).rejects.toThrow('toggles must name')
    await c.call('channels:setNotify', 'telegram', { ...OFF, replied: true })
    expect((await c.call<ChannelStatus[]>('channels:status')).find((x) => x.platform === 'telegram')!.notify.replied).toBe(true)
    await c.call('chats:send', web.id, 'second', [])
    const notice = await tg.waitFor((x) => x.method === 'sendMessage' && String(x.params.text) === '<b>Web plan</b>\nTester replied')
    // Title-only: what was said never goes.
    expect(texts().some((t) => t.includes('pong') || t.includes('second'))).toBe(false)
    // A turn started in Telegram already sends its reply there: no "replied" notice on top.
    tg.message(OWNER, '/new tester')
    await until(() => texts().some((t) => t.startsWith('New chat:')))
    tg.message(OWNER, 'ping')
    await until(() => texts().some((t) => t.includes('pong')))
    await new Promise((r) => setTimeout(r, 600))
    expect(texts().filter((t) => t.endsWith('Tester replied'))).toHaveLength(1)
    // Replying to the notice writes to its chat.
    tg.message(OWNER, 'from the notice', { reply_to_message: { message_id: notice.messageId } })
    await until(async () => (await itemsOf(c, web.id)).some((i) => i.type === 'user' && (i as { text: string }).text === 'from the notice'))
  })

  it("a web turn's waiting notice brings its question as an answerable card, with the options as bullets", async () => {
    const input = {
      questions: [
        {
          question: 'Does it work?',
          header: 'Quick check',
          multiSelect: false,
          options: [
            { label: 'Yes', description: 'It works.' },
            { label: 'No', description: 'It fails.' }
          ]
        }
      ]
    }
    const responses = await scriptCard('AskUserQuestion', input)
    const { c } = await paired()
    const OFF = { waiting: false, replied: false, error: false, routineFailed: false, workflow: false }
    await c.call('channels:setNotify', 'telegram', { ...OFF, waiting: true })
    const web = await c.call<ChatMeta>('chats:create', 'tester', root)
    await c.call('chats:rename', web.id, 'Web ask')
    void c.call('chats:send', web.id, 'ask me', []).catch(() => undefined)
    await tg.waitFor((x) => x.method === 'sendMessage' && String(x.params.text).startsWith('<b>Web ask</b>\nTester needs you'))
    const card = await cardMsg('Yes')
    const text = String(card.params.text)
    expect(text).toContain('Does it work?')
    expect(text).toContain('• <b>Yes</b> — It works.')
    expect(text).toContain('• <b>No</b> — It fails.')
    tg.press(OWNER, card.messageId!, tokenOf(card, 'No'))
    await until(async () => (await responses()).length === 1)
    expect((await responses())[0].response.updatedInput.answers).toEqual({ 'Does it work?': 'No' })
    await tg.waitFor((x) => x.method === 'editMessageText' && String(x.params.text).includes('✓ No'))
  })

  it("a web turn's question stays title-only when its agent is off for the channel", async () => {
    await scriptCard('AskUserQuestion', {
      questions: [
        {
          question: 'Does it work?',
          header: 'Check',
          multiSelect: false,
          options: [
            { label: 'Yes', description: '' },
            { label: 'No', description: '' }
          ]
        }
      ]
    })
    const { c } = await paired()
    await c.call('channels:setNotify', 'telegram', { waiting: true, replied: false, error: false, routineFailed: false, workflow: false })
    await c.call('channels:setAgents', 'telegram', [])
    const web = await c.call<ChatMeta>('chats:create', 'tester', root)
    void c.call('chats:send', web.id, 'ask me', []).catch(() => undefined)
    await tg.waitFor((x) => x.method === 'sendMessage' && String(x.params.text).includes('Tester needs you'))
    await new Promise((r) => setTimeout(r, 400))
    expect(texts().some((t) => t.includes('Does it work?'))).toBe(false)
  })

  it("a web turn's waiting notice brings its approval card, and Allow once answers it", async () => {
    const responses = await scriptCard('Bash', { command: 'npm test', description: 'Run the tests' })
    const { c } = await paired()
    await c.call('channels:setNotify', 'telegram', { waiting: true, replied: false, error: false, routineFailed: false, workflow: false })
    const web = await c.call<ChatMeta>('chats:create', 'tester', root)
    void c.call('chats:send', web.id, 'test it', []).catch(() => undefined)
    await tg.waitFor((x) => x.method === 'sendMessage' && String(x.params.text).includes('Tester needs you'))
    const card = await cardMsg('Allow once')
    expect(String(card.params.text)).toContain('<pre>npm test</pre>')
    tg.press(OWNER, card.messageId!, tokenOf(card, 'Allow once'))
    await until(async () => (await responses()).length === 1)
    expect((await responses())[0].response.behavior).toBe('allow')
    await tg.waitFor((x) => x.method === 'editMessageText' && String(x.params.text).includes('✓ Allowed once'))
  })
})
