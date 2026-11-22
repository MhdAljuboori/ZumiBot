import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import type { DesktopHandoff } from '@zumibot/shared/desktop'
import type { ChatItem } from '@zumibot/shared/types'
import { createDesktopApplication } from '../../../src/core/desktop/desktopApplication'
import { DESKTOP_ASK_RULES } from '../../../src/core/desktop/desktopIpc'
import { AgentStore } from '../../../src/core/agents/agentStore'
import { ChatStore } from '../../../src/core/store/chatStore'
import { createItemsFeed } from '../../../src/rpc/itemsFeed'
import type { DesktopRuntime } from '../../../src/core/desktop/desktopRuntime'
import type { CuaResult, DesktopAdapter, DesktopInstance } from '../../../src/core/desktop/types'

class FakeDesktop implements DesktopInstance {
  readonly display = 90
  closed = false
  constructor(
    readonly generation: string,
    readonly vncSocket: string
  ) {}
  async call(tool: string): Promise<CuaResult> {
    return {
      content: tool === 'get_desktop_state' ? [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }] : [],
      isError: false,
      structuredContent: {}
    }
  }
  isClosed() {
    return this.closed
  }
  onExit() {
    return () => {}
  }
  async close() {
    this.closed = true
  }
}
class FakeAdapter implements DesktopAdapter {
  instances: FakeDesktop[] = []
  async launch(dir: string): Promise<DesktopInstance> {
    const instance = new FakeDesktop(`gen${this.instances.length + 1}`, join(dir, 'vnc.sock'))
    this.instances.push(instance)
    return instance
  }
}
const runtime = (missing: string[] = []): DesktopRuntime => ({
  xvnc: '/usr/bin/Xvnc',
  dbusDaemon: '/usr/bin/dbus-daemon',
  session: ['/bin/sh'],
  cuaDriver: '/usr/bin/cua-driver',
  node: process.execPath,
  bridgeEntry: '/opt/zumibot/desktopBridge.mjs',
  electronNode: false,
  missing
})
const agent = (name: string, on = false) => `---\nname: ${name}\ndescription: Test\n${on ? 'computerUse: true\n' : ''}---\nTest agent.`
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

let root: string, agents: AgentStore, chats: ChatStore, adapter: FakeAdapter, feed: ReturnType<typeof createItemsFeed>
let apps: Awaited<ReturnType<typeof createDesktopApplication>>[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'desktop-app-'))
  await mkdir(join(root, 'agents'))
  await writeFile(join(root, 'agents', 'helper.md'), agent('helper', true))
  await writeFile(join(root, 'agents', 'plain.md'), agent('plain'))
  // A hand-edited built-in file must not get a desktop.
  await writeFile(join(root, 'agents', `${ZUMI_BOT_NAME}.md`), agent(ZUMI_BOT_NAME, true))
  await writeFile(join(root, 'agents', 'broken.md'), 'no frontmatter, computerUse: true')
  agents = new AgentStore(join(root, 'agents'), async () => {}, undefined, ZUMI_BOT_NAME)
  chats = new ChatStore(root)
  adapter = new FakeAdapter()
  feed = createItemsFeed()
})
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close().catch(() => {})
  await rm(root, { recursive: true, force: true })
})
const start = async (o: { missing?: string[] } = {}) => {
  const app = await createDesktopApplication({ dataDir: root, agents, chats, feed, adapter, runtime: runtime(o.missing) })
  apps.push(app)
  return app
}
const mapping = async () =>
  (JSON.parse(await readFile(join(root, 'desktops', 'profiles.json'), 'utf8')) as { profiles: Record<string, string> }).profiles

describe('desktop application', () => {
  it('plan is off for Zumi Bot and for agents without the key', async () => {
    const a = await start()
    const chat = await chats.create('helper', root),
      plain = await chats.create('plain', root),
      builtInChat = await chats.create(ZUMI_BOT_NAME, root)
    expect(await a.turns.plan('plain', plain.id)).toBe('off')
    expect(await a.turns.plan(ZUMI_BOT_NAME, builtInChat.id)).toBe('off')
    expect(await a.turns.plan('broken', chat.id)).toBe('off')
    expect(await a.turns.plan('missing', chat.id)).toBe('off')
    const plan = await a.turns.plan('helper', chat.id)
    expect(plan).toEqual({ profileId: expect.stringMatching(uuid) })
    // Only the agent with computer use got a desktop profile, and nothing was launched for it.
    expect(await mapping()).toEqual({ helper: (plan as { profileId: string }).profileId })
    expect(a.agents()).toEqual(['helper'])
    expect(adapter.instances).toHaveLength(0)
    // A computer-use agent outside the chat is refused, as for the browser.
    await expect(a.turns.plan('helper', plain.id)).rejects.toThrow()
  })

  it('plan is unavailable when programs are missing, with no profile made', async () => {
    const a = await start({ missing: ['TigerVNC (Xvnc)'] }),
      chat = await chats.create('helper', root)
    expect(await a.turns.plan('helper', chat.id)).toBe('unavailable')
    expect(await a.turns.plan('plain', chat.id)).toBe('off')
    expect(await a.status('helper')).toMatchObject({ agent: 'helper', state: 'unavailable', missing: ['TigerVNC (Xvnc)'] })
    await expect(stat(join(root, 'desktops', 'profiles.json'))).rejects.toThrow()
  })

  it('plan is unavailable when desktop data cannot be read, which it never overwrites', async () => {
    await mkdir(join(root, 'desktops'))
    await writeFile(join(root, 'desktops', 'profiles.json'), 'broken metadata')
    const a = await start(),
      chat = await chats.create('helper', root)
    expect(await a.turns.plan('helper', chat.id)).toBe('unavailable')
    expect(await a.status('helper')).toMatchObject({ state: 'unavailable' })
    await expect(a.clear('helper')).rejects.toThrow('Desktop unavailable')
    await expect(a.resolveTarget({ agent: 'helper', chatId: chat.id })).rejects.toThrow('Desktop unavailable')
    expect(a.agents()).toEqual([])
    expect(await readFile(join(root, 'desktops', 'profiles.json'), 'utf8')).toBe('broken metadata')
  })

  it('status is off for an agent without computer use and refuses unknown agents', async () => {
    const a = await start()
    expect(await a.status('plain')).toEqual({
      agent: 'plain',
      profileId: '',
      generation: '',
      state: 'off',
      control: 'agent',
      pendingRequestId: null,
      error: null,
      width: 1280,
      height: 800,
      busy: false
    })
    expect(await a.status(ZUMI_BOT_NAME)).toMatchObject({ state: 'off' })
    expect(await a.status('helper')).toMatchObject({ agent: 'helper', state: 'stopped', profileId: expect.stringMatching(uuid) })
    await expect(a.status('missing')).rejects.toThrow()
    await expect(a.status('broken')).rejects.toThrow()
    await expect(a.clear('missing')).rejects.toThrow()
    await expect(a.clear(ZUMI_BOT_NAME)).rejects.toThrow()
    // Clearing an agent that never had a desktop makes no profile.
    await a.clear('plain')
    expect(await mapping()).toEqual({ helper: expect.stringMatching(uuid) })
  })

  it('a viewer target needs computer use and chat membership', async () => {
    const a = await start(),
      chat = await chats.create('helper', root),
      plain = await chats.create('plain', root)
    await expect(a.resolveTarget({ agent: 'plain', chatId: plain.id })).rejects.toThrow('Computer use is off for this agent')
    await expect(a.resolveTarget({ agent: ZUMI_BOT_NAME })).rejects.toThrow()
    await expect(a.resolveTarget({ agent: 'missing' })).rejects.toThrow()
    await expect(a.resolveTarget({ agent: 'helper', chatId: plain.id })).rejects.toThrow()
    await expect(a.resolveTarget({ agent: 'helper', requestId: 'card' })).rejects.toThrow()
    expect((await a.resolveTarget({ agent: 'helper', chatId: chat.id })).agent).toBe('helper')
  })

  it('a browser handoff id is not accepted as a desktop request and vice versa', async () => {
    const a = await start(),
      chat = await chats.create('helper', root)
    const { profileId } = (await a.turns.plan('helper', chat.id)) as { profileId: string }
    const owner = { profileId, chatId: chat.id, turnId: randomUUID() }
    let card!: DesktopHandoff
    const save = async (item: ChatItem) => {
      await chats.saveItems(chat.id, [item])
      feed.reset()
    }
    const desktopCard = (handoff: DesktopHandoff): ChatItem => ({
      type: 'browser-action',
      surface: 'desktop',
      id: handoff.id,
      ts: handoff.createdAt,
      agent: handoff.agent,
      handoff
    })
    const turn = await a.turns.create(owner, async (handoff) => {
      card = handoff
      await save(desktopCard(handoff))
    })
    const pending = a.manager.run(owner, { op: 'requestUserAction', reason: 'Sign in' }, new AbortController().signal)
    await vi.waitFor(() => expect(card).toBeDefined())
    const target = { agent: 'helper', chatId: chat.id, requestId: card.id }
    expect((await a.resolveTarget(target)).id).toBe(profileId)
    // The same pending handoff as a browser card (no surface) is not a desktop request.
    await save({ type: 'browser-action', id: card.id, ts: card.createdAt, agent: card.agent, handoff: card })
    await expect(a.resolveTarget(target)).rejects.toThrow('Stale desktop action request')
    await save(desktopCard({ ...card, turnId: 'different-turn' }))
    await expect(a.resolveTarget(target)).rejects.toThrow('Stale desktop action request')
    await save(desktopCard({ ...card, generation: 'wrong' }))
    await expect(a.resolveTarget(target)).rejects.toThrow('Stale desktop action request')
    await turn.dispose()
    expect(await pending).toMatchObject({ ok: false, code: 'handoff_interrupted' })
  })

  it('main turns force the ask rules, side turns leave them to the guard, each with its own capability', async () => {
    const a = await start(),
      chat = await chats.create('helper', root)
    const { profileId } = (await a.turns.plan('helper', chat.id)) as { profileId: string }
    const main = await a.turns.create({ profileId, chatId: chat.id, turnId: randomUUID() }, async () => {})
    const side = await a.turns.create({ profileId, chatId: chat.id, turnId: randomUUID() }, async () => {}, { side: true })
    expect(main.args).toEqual([
      '--mcp-config',
      expect.stringContaining('zumibot_desktop'),
      '--settings',
      JSON.stringify({ permissions: { ask: DESKTOP_ASK_RULES } })
    ])
    expect(side.args).toEqual(['--mcp-config', expect.stringContaining('zumibot_desktop')])
    expect(main.env.ZUMIBOT_DESKTOP_CAPABILITY).toBeTruthy()
    expect(main.env.ZUMIBOT_DESKTOP_CAPABILITY).not.toBe(side.env.ZUMIBOT_DESKTOP_CAPABILITY)
    expect(adapter.instances).toHaveLength(0)
    await main.dispose()
    await side.dispose()
  })

  it('keeps the profile on rename and detaches it on removal without deleting its data', async () => {
    const a = await start(),
      chat = await chats.create('helper', root)
    const first = (await a.turns.plan('helper', chat.id)) as { profileId: string }
    await writeFile(join(root, 'agents', 'helper.md'), agent('renamed', true))
    await chats.renameAgent('helper', 'renamed')
    await a.renameAgent('helper', 'renamed')
    expect(await a.turns.plan('renamed', chat.id)).toEqual(first)
    expect(a.agents()).toEqual(['renamed'])
    await a.removeAgents(['renamed'])
    expect(a.agents()).toEqual([])
    expect((await stat(join(root, 'desktops', first.profileId))).isDirectory()).toBe(true)
    expect(await a.turns.plan('renamed', chat.id)).not.toEqual(first)
  })

  it('close stops running desktops and refuses later turns', async () => {
    const a = await start(),
      chat = await chats.create('helper', root)
    const { profileId } = (await a.turns.plan('helper', chat.id)) as { profileId: string }
    const owner = { profileId, chatId: chat.id, turnId: randomUUID() }
    expect((await a.manager.run(owner, { op: 'screenshot' }, new AbortController().signal)).ok).toBe(true)
    expect(adapter.instances).toHaveLength(1)
    await a.close()
    expect(adapter.instances[0].closed).toBe(true)
    await expect(a.turns.create({ ...owner, turnId: randomUUID() }, async () => {})).rejects.toThrow('Desktop unavailable')
  })
})
