import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { WebSocket } from 'ws'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { writeFakeBin } from './support/fakeBin'
import { PROCESS_REFUSALS, type ProcessInfo } from '@zumibot/shared/processes'
import type { ChatItem, ChatMeta, ItemsPage } from '@zumibot/shared/types'
import type { RpcEvent, RpcResponse } from '@zumibot/shared/rpc'
import { stopServer } from './support/stopServer'
import { removeDir } from './support/platform'

// The built bundle with a fake claude that runs the real injected zumibot_processes bridge: a process started in one
// turn is read in the next, stopped from the UI, ended by an archive and by the server's stop.
const SECRET = 'test-secret-'.padEnd(40, 'x')
const backendDir = fileURLToPath(new URL('..', import.meta.url))
const fake = fileURLToPath(new URL('./fixtures/fake-process-claude.mjs', import.meta.url))

let outDir: string, root: string, dataDir: string, agentsDir: string, logFile: string
let child: ChildProcess | null = null

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'cb-proc-bundle-'))
  await build({ root: backendDir, logLevel: 'silent', build: { outDir, emptyOutDir: true } })
}, 90_000)
afterAll(() => removeDir(outDir))
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cb-proc-app-'))
  dataDir = join(root, 'data')
  agentsDir = join(root, 'agents')
  logFile = join(root, 'log.jsonl')
  await mkdir(dataDir)
  await mkdir(agentsDir)
  await mkdir(join(root, 'repo'))
  await writeFile(join(agentsDir, 'tester.md'), '---\nname: tester\ndescription: Test agent\n---\nTest agent.')
  const claude = writeFakeBin(root, 'claude', fake)
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ claudePath: claude }))
})
afterEach(async () => {
  await stopServer(child)
  child = null
  removeDir(root)
})

const env = (): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: root,
  ZUMIBOT_MODE: 'local',
  ZUMIBOT_LOCAL_SECRET: SECRET,
  ZUMIBOT_DATA_DIR: dataDir,
  ZUMIBOT_AGENTS_DIR: agentsDir,
  ZUMIBOT_PORT: '0',
  ZUMIBOT_VAULT_KEY_FILE: join(root, 'vault-key', 'vault.key'),
  ZUMIBOT_PERMISSION_MODE: 'manual'
})

const until = async (cond: () => boolean | Promise<boolean>, ms = 15000): Promise<void> => {
  const end = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}
// The pid Windows knows: Git Bash's $$ is its own numbering, which process.kill cannot see.
const WEB = `echo pid=${process.platform === 'win32' ? '$(cat /proc/$$/winpid)' : '$$'}; echo ready-$((1+1)); sleep 300`
// A zombie (an orphan a non-reaping PID 1 holds) is dead.
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return true
  }
}

async function serve(): Promise<{ port: number; exited: Promise<number | null> }> {
  child = spawn(process.execPath, [join(outDir, 'server.mjs'), 'serve'], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout!.on('data', (d) => (out += d))
  const exited = new Promise<number | null>((r) => child!.once('exit', (code) => r(code)))
  await until(() => /LISTENING \d+/.test(out))
  return { port: Number(/LISTENING (\d+)/.exec(out)![1]), exited }
}

function connect(
  port: number
): Promise<{ ws: WebSocket; call<T = unknown>(method: string, ...args: unknown[]): Promise<T>; events: RpcEvent[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: `cb_local=${SECRET}`, Origin: `http://127.0.0.1:${port}` } })
  const events: RpcEvent[] = []
  const waiting = new Map<number, (r: RpcResponse) => void>()
  let id = 0
  ws.on('message', (d) => {
    const m = JSON.parse(String(d)) as RpcResponse | RpcEvent
    if ('event' in m) events.push(m)
    else waiting.get(m.id)?.(m)
  })
  return new Promise((resolve, reject) => {
    ws.once('error', reject)
    ws.once('open', () =>
      resolve({
        ws,
        events,
        call: <T>(method: string, ...args: unknown[]) =>
          new Promise<T>((res, rej) => {
            const n = ++id
            waiting.set(n, (r) => (r.ok ? res(r.value as T) : rej(new Error(r.error))))
            ws.send(JSON.stringify({ id: n, method, args }))
          })
      })
    )
  })
}

const scenario = (steps: unknown[]) => `PROCESS_SCENARIO:${Buffer.from(JSON.stringify({ log: logFile, steps })).toString('base64')}`
const logged = async () =>
  (await readFile(logFile, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
const entry = async (name: string) => (await logged()).filter((e) => e.name === name).pop()
const cli = (what: string) =>
  new Promise<string>((resolve) => {
    const p = spawn(process.execPath, [join(outDir, 'server.mjs'), what], { env: env() })
    let o = ''
    p.stdout.on('data', (d) => (o += d))
    p.on('exit', () => resolve(o.trim()))
  })

type Client = Awaited<ReturnType<typeof connect>>
const pendingCard = async (c: Client, chatId: string) => {
  const page = await c.call<ItemsPage>('chats:items', chatId)
  return page.items.find((i): i is Extract<ChatItem, { type: 'approval' }> => i.type === 'approval' && i.status === 'pending')
}

describe('background processes (built bundle, real bridge)', () => {
  it('starts in one turn behind a card, reads its log in the next, stops from the UI, and ends on archive', async () => {
    const { port } = await serve()
    const c = await connect(port)
    const chat = await c.call<ChatMeta>('chats:create', 'tester', join(root, 'repo'))
    // Turn 1: a start behind its card, then a wait for its ready line.
    const t1 = c.call(
      'chats:send',
      chat.id,
      scenario([
        { argv: true },
        { tool: 'start', args: { command: WEB, name: 'web' }, save: 'web' },
        { tool: 'wait', args: { id: { $id: 'web' }, patterns: ['ready-2'], timeoutSeconds: 10 }, save: 'waited' }
      ]),
      []
    )
    await until(async () => (await pendingCard(c, chat.id)) !== undefined)
    const card = (await pendingCard(c, chat.id))!
    expect(card.toolName).toBe('mcp__zumibot_processes__start')
    expect(card.input).toMatchObject({ command: WEB, name: 'web' })
    await c.call('chats:answer', chat.id, card.id, 'allow-chat')
    await t1
    const argv = (await entry('argv'))!
    expect(argv.servers).toContain('zumibot_processes')
    expect(argv.asks).toContain('mcp__zumibot_processes__start')
    expect(argv.settings).toBe(1)
    expect(argv.timeout).toBe(150000)
    expect(await entry('fixture-error')).toBeUndefined()
    expect((await entry('waited'))!.text).toMatch(/^Matched: ready-2/)
    const webId = (await entry('web'))!.id as string
    let list = await c.call<ProcessInfo[]>('processes:list', chat.id)
    expect(list[0]).toMatchObject({ id: webId, name: 'web', state: 'running', startedBy: 'tester' })
    expect(list[0]).not.toHaveProperty('pid')
    expect(await c.call('processes:counts')).toEqual({ [chat.id]: 1 })
    expect(c.events.some((e) => e.event === 'processes:changed')).toBe(true)
    // A process is not a reply: busy stays 0, the separate line counts it.
    expect(await cli('busy')).toBe('0')
    expect(await cli('processes')).toBe('1')
    const pid = Number(/pid=(\d+)/.exec((await c.call<{ text: string }>('processes:logs', chat.id, webId)).text)![1])
    expect(alive(pid)).toBe(true)

    // Turn 2: the process outlived turn 1; this turn reads its log. No card for logs or list.
    await c.call(
      'chats:send',
      chat.id,
      scenario([
        { tool: 'logs', args: { id: { $id: 'web' } }, save: 'read' },
        { tool: 'list', save: 'listed' }
      ]),
      []
    )
    expect((await entry('read'))!.text).toContain('ready-2')
    expect((await entry('listed'))!.text).toContain('"web": running')

    // Turn 3: the same command and folder was allowed for this chat, a different one asks again (denied here).
    const t3 = c.call(
      'chats:send',
      chat.id,
      scenario([
        { tool: 'start', args: { command: WEB, name: 'web2' }, save: 'web2' },
        { tool: 'start', args: { command: 'echo other; sleep 300' }, save: 'other' }
      ]),
      []
    )
    await until(async () => (await pendingCard(c, chat.id))?.input !== undefined)
    const second = (await pendingCard(c, chat.id))!
    expect(second.input).toMatchObject({ command: 'echo other; sleep 300' })
    await c.call('chats:answer', chat.id, second.id, 'deny')
    await t3
    expect((await entry('web2'))!.id).toMatch(/^p_/)
    expect((await entry('other'))!.denied).toBe(true)

    // The user stops the first from the panel: its whole tree ends.
    expect(await c.call<ProcessInfo>('processes:stop', chat.id, webId)).toMatchObject({ state: 'stopped', stoppedBy: 'user' })
    expect(alive(pid)).toBe(false)
    // Archiving ends the rest.
    await c.call('chats:archive', chat.id, true)
    list = await c.call<ProcessInfo[]>('processes:list', chat.id)
    expect(list.find((p) => p.name === 'web2')).toMatchObject({ state: 'stopped', stoppedBy: 'archive' })
    expect(await c.call('processes:counts')).toEqual({})
    await expect(c.call('processes:logs', chat.id, '../etc')).rejects.toThrow('id must be a process id')
    c.ws.close()
  }, 90_000)

  it('refuses a start while a Plan turn plans, before any card', async () => {
    const { port } = await serve()
    const c = await connect(port)
    const chat = await c.call<ChatMeta>('chats:create', 'tester', join(root, 'repo'))
    await c.call('chats:setPermissionMode', chat.id, 'plan')
    await c.call('chats:send', chat.id, scenario([{ tool: 'start', args: { command: 'sleep 300' }, save: 'planned' }]), [])
    expect(await entry('planned')).toMatchObject({ denied: true, message: PROCESS_REFUSALS.plan })
    expect(await pendingCard(c, chat.id)).toBeUndefined()
    expect(await c.call('processes:counts')).toEqual({})
    c.ws.close()
  }, 60_000)

  it('a notify rule wakes the agent after its turn ended: one auto message with the event and the tail, then a reply', async () => {
    const { port } = await serve()
    const c = await connect(port)
    const chat = await c.call<ChatMeta>('chats:create', 'tester', join(root, 'repo'))
    const t1 = c.call(
      'chats:send',
      chat.id,
      scenario([
        { tool: 'start', args: { command: 'sleep 0.8; echo done-building; exit 2', name: 'build', notify: { on: 'exit' } }, save: 'build' }
      ]),
      []
    )
    await until(async () => (await pendingCard(c, chat.id)) !== undefined)
    await c.call('chats:answer', chat.id, (await pendingCard(c, chat.id))!.id, 'allow-once')
    await t1
    expect((await entry('build'))!.text).toContain('You will get a message in this chat when it exits')
    // The process ends after the reply did; the wake-up is its own turn.
    const wake = async () =>
      (await c.call<ItemsPage>('chats:items', chat.id)).items.find((i) => i.type === 'user' && i.text.includes('Background process update'))
    await until(async () => (await wake()) !== undefined)
    const msg = (await wake()) as Extract<ChatItem, { type: 'user' }>
    // As a routine's, the stored message is a plain user item: its first line says who sent it.
    expect(msg.text.startsWith('Background process update (sent by ZumiBot')).toBe(true)
    expect(msg.text).toContain('exited with code 2.')
    expect(msg.text).toContain('done-building')
    // The agent ran on it: the fixture answers a message with no scenario.
    await until(async () => JSON.stringify((await c.call<ItemsPage>('chats:items', chat.id)).items).includes('No scenario.'))
    expect((await c.call<ProcessInfo[]>('processes:list', chat.id))[0].wake).toMatchObject({ on: 'exit', fired: 1, note: null })
    c.ws.close()
  }, 60_000)

  it('in a room the wake-up goes to the member that started the process', async () => {
    const { port } = await serve()
    const c = await connect(port)
    await writeFile(join(agentsDir, 'helper.md'), '---\nname: helper\ndescription: Second member\n---\nHelper.')
    await until(async () => (await c.call<{ name: string }[]>('agents:list')).some((a) => a.name === 'helper'))
    const room = await c.call<ChatMeta>('chats:createGroup', ['tester', 'helper'], join(root, 'repo'), '')
    const t1 = c.call(
      'chats:send',
      room.id,
      `@tester ${scenario([{ tool: 'start', args: { command: 'sleep 0.8; exit 0', name: 'job', notify: { on: 'exit' } }, save: 'job' }])}`,
      []
    )
    await until(async () => (await pendingCard(c, room.id)) !== undefined)
    await c.call('chats:answer', room.id, (await pendingCard(c, room.id))!.id, 'allow-once', 'tester')
    await t1
    const items = async () => (await c.call<ItemsPage>('chats:items', room.id)).items
    await until(async () => (await items()).some((i) => i.type === 'user' && i.text.startsWith('@tester\nBackground process update')))
    // The member answers it: the fixture's reply to a message with no scenario.
    await until(async () => JSON.stringify(await items()).includes('No scenario.'), 30_000)
    c.ws.close()
  }, 60_000)

  // SIGTERM to the server: Windows has no graceful signal for a child, only TerminateProcess.
  it.skipIf(process.platform === 'win32')(
    'the server stop ends every tree and writes it stopped',
    async () => {
      const { port, exited } = await serve()
      const c = await connect(port)
      const chat = await c.call<ChatMeta>('chats:create', 'tester', join(root, 'repo'))
      const t = c.call(
        'chats:send',
        chat.id,
        scenario([
          { tool: 'start', args: { command: 'echo pid=$$; sleep 300 & wait' }, save: 'job' },
          { tool: 'wait', args: { id: { $id: 'job' }, patterns: ['pid='], timeoutSeconds: 10 } }
        ]),
        []
      )
      await until(async () => (await pendingCard(c, chat.id)) !== undefined)
      await c.call('chats:answer', chat.id, (await pendingCard(c, chat.id))!.id, 'allow-once')
      await t
      const id = (await entry('job'))!.id as string
      const pid = Number(/pid=(\d+)/.exec((await c.call<{ text: string }>('processes:logs', chat.id, id)).text)![1])
      expect(alive(pid)).toBe(true)
      child!.kill('SIGTERM')
      expect(await exited).toBe(0)
      child = null
      expect(alive(pid)).toBe(false)
      const index = JSON.parse(await readFile(join(dataDir, 'processes', 'index.json'), 'utf8')) as {
        items: { state: string; stoppedBy: string }[]
      }
      expect(index.items[0]).toMatchObject({ state: 'stopped', stoppedBy: 'shutdown' })
    },
    60_000
  )
})
