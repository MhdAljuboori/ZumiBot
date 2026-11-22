import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createBrowserApplication } from '../../src/core/browser/browserApplication'
import { AgentStore } from '../../src/core/agents/agentStore'
import { ChatStore } from '../../src/core/store/chatStore'
import { createItemsFeed } from '../../src/rpc/itemsFeed'
import { FakeBrowserAdapter } from '../support/fakeBrowser'
import { identity, writeOwner } from '../../src/core/browser/browserProcess'
import * as browserProcess from '../../src/core/browser/browserProcess'
import type { BrowserHandoff } from '../../src/core/browser/types'
import { ChatService } from '../../src/core/chat/chatService'
import { AttachmentStore } from '../../src/core/attachments/attachmentStore'
import type { RunOutcome } from '../../src/core/chat/claudeRunner'
import type { BrowserOwner, BrowserResult } from '../../src/core/browser/types'

let root: string, agents: AgentStore, chats: ChatStore, adapter: FakeBrowserAdapter
let app: Awaited<ReturnType<typeof createBrowserApplication>> | undefined
let feed: ReturnType<typeof createItemsFeed>
const agent = (name: string) => `---\nname: ${name}\ndescription: Test\n---\nTest agent.`
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'browser-app-'))
  await mkdir(join(root, 'agents'))
  await writeFile(join(root, 'agents', 'helper.md'), agent('helper'))
  agents = new AgentStore(join(root, 'agents'), async () => {})
  chats = new ChatStore(root)
  adapter = new FakeBrowserAdapter()
  feed = createItemsFeed()
})
afterEach(async () => {
  await app?.close()
  app = undefined
  await rm(root, { recursive: true, force: true })
})
const start = async () => (app = await createBrowserApplication({ dataDir: root, agents, chats, feed, adapter }))

describe('browser application integration', () => {
  it.each(['clear', 'delete'] as const)(
    'an expired-session retry after %s keeps the revoked profile and is denied instead of rebinding',
    async (action) => {
      const a = await start(),
        chat = await chats.create('helper', root)
      await chats.update(chat.id, { sessionId: 'old' })
      let finish!: (outcome: RunOutcome) => void
      const owners: BrowserOwner[] = [],
        results: BrowserResult[] = []
      const success: RunOutcome = {
        exitCode: 0,
        signal: null,
        stderr: '',
        spawnError: null,
        stopped: false,
        result: {
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
      }
      const svc = new ChatService({
        store: chats,
        files: new AttachmentStore(join(root, 'attachments'), randomUUID),
        locate: async () => '/fake/claude',
        run: () => ({
          done:
            owners.length === 1
              ? new Promise<RunOutcome>((resolve) => {
                  finish = resolve
                })
              : Promise.resolve(success),
          stop: () => {},
          send: () => true
        }),
        push: () => {},
        now: Date.now,
        newId: randomUUID,
        permissionMode: 'auto',
        disallowedToolsFor: () => [],
        browserTurns: {
          profileId: a.turns.profileId,
          create: async (owner, callback) => {
            owners.push(owner)
            const turn = await a.turns.create(owner, callback)
            if (owners.length === 2) results.push(await a.manager.run(owner, { op: 'observe' }, new AbortController().signal))
            return turn
          }
        }
      })
      const done = svc.send(chat.id, 'go')
      await vi.waitFor(() => expect(typeof finish).toBe('function'))
      if (action === 'clear') await a.clear('helper')
      else {
        await rm(join(root, 'agents', 'helper.md'))
        await a.removeAgents(['helper'])
      }
      finish({ ...success, result: null, stderr: 'No conversation found with session ID: old' })
      await done
      expect(owners).toHaveLength(2)
      expect(owners[1].profileId).toBe(owners[0].profileId)
      expect(owners[1].turnId).not.toBe(owners[0].turnId)
      expect(results).toEqual([expect.objectContaining({ ok: false, code: 'stale_profile' })])
      expect(adapter.instances).toHaveLength(0)
    }
  )
  it('starts and creates a text-turn capability without launching Chromium, even with no browser binary', async () => {
    const a = await start(),
      chat = await chats.create('helper', root)
    const profileId = await a.turns.profileId('helper', chat.id)
    expect(profileId).toBeTruthy()
    const turn = await a.turns.create({ profileId: profileId!, chatId: chat.id, turnId: randomUUID() }, async () => {})
    expect(turn.args).toContain('--mcp-config')
    expect(adapter.instances).toHaveLength(0)
    await turn.dispose()
  })
  it('keeps text work usable with corrupt browser metadata without overwriting it', async () => {
    await mkdir(join(root, 'browsers'))
    await writeFile(join(root, 'browsers', 'profiles.json'), 'broken metadata')
    const a = await start(),
      chat = await chats.create('helper', root)
    expect(await a.turns.profileId('helper', chat.id)).toBeNull()
    await expect(a.status('helper')).rejects.toThrow('Browser unavailable')
    await expect(a.clear('helper')).rejects.toThrow('Browser unavailable')
    expect(await readFile(join(root, 'browsers', 'profiles.json'), 'utf8')).toBe('broken metadata')
    expect(adapter.instances).toHaveLength(0)
  })
  it('validates loadable agents, membership, and exact pending handoff identity before resolving a target', async () => {
    const a = await start(),
      chat = await chats.create('helper', root)
    await writeFile(join(root, 'agents', 'other.md'), agent('other'))
    await expect(a.resolveTarget({ agent: 'missing' })).rejects.toThrow()
    await expect(a.resolveTarget({ agent: 'other', chatId: chat.id })).rejects.toThrow()
    await expect(a.status('missing')).rejects.toThrow()
    await expect(a.clear('missing')).rejects.toThrow()
    await expect(a.resolveTarget({ agent: 'helper', requestId: 'card' })).rejects.toThrow()
    const profileId = (await a.resolveTarget({ agent: 'helper', chatId: chat.id })).id
    const owner = { profileId, chatId: chat.id, turnId: randomUUID() }
    let card!: BrowserHandoff
    const turn = await a.turns.create(owner, async (handoff) => {
      card = handoff
      await chats.saveItems(chat.id, [{ type: 'browser-action', id: handoff.id, ts: handoff.createdAt, agent: handoff.agent, handoff }])
    })
    const pending = a.manager.run(owner, { op: 'requestUserAction', reason: 'Help' }, new AbortController().signal)
    await vi.waitFor(() => expect(card).toBeDefined())
    expect((await a.resolveTarget({ agent: 'helper', chatId: chat.id, requestId: card.id })).id).toBe(profileId)
    await chats.saveItems(chat.id, [
      { type: 'browser-action', id: card.id, ts: card.createdAt, agent: card.agent, handoff: { ...card, turnId: 'different-turn' } }
    ])
    feed.reset()
    await expect(a.resolveTarget({ agent: 'helper', chatId: chat.id, requestId: card.id })).rejects.toThrow()
    await chats.saveItems(chat.id, [
      { type: 'browser-action', id: card.id, ts: card.createdAt, agent: card.agent, handoff: { ...card, generation: 'wrong' } }
    ])
    feed.reset()
    await expect(a.resolveTarget({ agent: 'helper', chatId: chat.id, requestId: card.id })).rejects.toThrow()
    await turn.dispose()
    await pending
  })
  it('a desktop handoff card is never accepted as a browser request', async () => {
    const a = await start(),
      chat = await chats.create('helper', root)
    const profileId = (await a.resolveTarget({ agent: 'helper', chatId: chat.id })).id
    const owner = { profileId, chatId: chat.id, turnId: randomUUID() }
    let card!: BrowserHandoff
    const turn = await a.turns.create(owner, async (handoff) => {
      card = handoff
      await chats.saveItems(chat.id, [{ type: 'browser-action', id: handoff.id, ts: handoff.createdAt, agent: handoff.agent, handoff }])
    })
    const pending = a.manager.run(owner, { op: 'requestUserAction', reason: 'Help' }, new AbortController().signal)
    await vi.waitFor(() => expect(card).toBeDefined())
    const target = { agent: 'helper', chatId: chat.id, requestId: card.id }
    expect((await a.resolveTarget(target)).id).toBe(profileId)
    // Everything else matches the live browser handoff; only the card says it is a desktop one.
    await chats.saveItems(chat.id, [
      { type: 'browser-action', surface: 'desktop', id: card.id, ts: card.createdAt, agent: card.agent, handoff: card }
    ])
    feed.reset()
    await expect(a.resolveTarget(target)).rejects.toThrow('Stale browser action request')
    await turn.dispose()
    await pending
  })
  // Browser process ownership reads /proc, so the browser is Linux-only.
  it.skipIf(process.platform !== 'linux').each(['malformed', 'unconfirmed', 'launching'] as const)(
    'globally refuses %s ownership in an orphan profile before a different profile can launch',
    async (state) => {
      const orphan = join(root, 'browsers', randomUUID())
      await mkdir(orphan, { recursive: true })
      if (state === 'malformed') await writeFile(join(orphan, '.zumibot-browser-owner.json'), '{}')
      else
        await writeOwner({
          version: 2,
          profile: orphan,
          state,
          token: randomUUID(),
          worker: { pid: 2147483646, start: '1' },
          parent: await identity(process.pid),
          processes: []
        })
      const a = await start(),
        chat = await chats.create('helper', root)
      const profileId = await a.turns.profileId('helper', chat.id)
      expect(
        (
          await a.manager.run(
            { profileId: profileId!, chatId: chat.id, turnId: randomUUID() },
            { op: 'observe' },
            new AbortController().signal
          )
        ).ok
      ).toBe(false)
      expect(adapter.instances).toHaveLength(0)
    }
  )
  it('preserves profile identity on rename and detaches deletion without deleting orphaned data', async () => {
    const a = await start(),
      chat = await chats.create('helper', root)
    const profileId = await a.turns.profileId('helper', chat.id)
    await writeFile(join(root, 'agents', 'helper.md'), agent('renamed'))
    await chats.renameAgent('helper', 'renamed')
    await a.renameAgent('helper', 'renamed')
    expect(await a.turns.profileId('renamed', chat.id)).toBe(profileId)
    await a.removeAgents(['renamed'])
    expect(await a.turns.profileId('renamed', chat.id)).not.toBe(profileId)
  })
  it('allows two normal profiles after the single recovery barrier without rescanning live owners', async () => {
    await writeFile(join(root, 'agents', 'other.md'), agent('other'))
    const a = await start(),
      one = await chats.create('helper', root),
      two = await chats.create('other', root)
    const profile = await a.resolveTarget({ agent: 'helper', chatId: one.id })
    expect(
      (
        await a.manager.run(
          { profileId: profile.id, chatId: one.id, turnId: randomUUID() },
          { op: 'observe' },
          new AbortController().signal
        )
      ).ok
    ).toBe(true)
    // This synthetic live owner stands for the first worker's record; the lazy
    // initial barrier must not mistake this manager's running browser for an orphan.
    await writeFile(join(profile.dir, '.zumibot-browser-owner.json'), '{}')
    const secondId = await a.turns.profileId('other', two.id)
    expect(
      (await a.manager.run({ profileId: secondId!, chatId: two.id, turnId: randomUUID() }, { op: 'observe' }, new AbortController().signal))
        .ok
    ).toBe(true)
    expect(adapter.instances).toHaveLength(2)
  })
  it('gates concurrent first launches on one initial global recovery and never rescans', async () => {
    await writeFile(join(root, 'agents', 'other.md'), agent('other'))
    const realRecover = browserProcess.recoverBrowserProfiles
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const scan = vi.spyOn(browserProcess, 'recoverBrowserProfiles').mockImplementation(async (path) => {
      await gate
      await realRecover(path)
    })
    try {
      const a = await start(),
        one = await chats.create('helper', root),
        two = await chats.create('other', root)
      const first = await a.turns.profileId('helper', one.id),
        second = await a.turns.profileId('other', two.id)
      const launches = [first, second].map((profileId, i) =>
        a.manager.run(
          { profileId: profileId!, chatId: [one, two][i].id, turnId: randomUUID() },
          { op: 'observe' },
          new AbortController().signal
        )
      )
      await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1))
      // Both tasks have reached the shared checkpoint, but neither may launch yet.
      await vi.waitFor(async () => {
        expect((await a.manager.status('helper')).state).toBe('starting')
        expect((await a.manager.status('other')).state).toBe('starting')
      })
      expect(adapter.instances).toHaveLength(0)
      release()
      expect((await Promise.all(launches)).every((result) => result.ok)).toBe(true)
      expect(adapter.instances).toHaveLength(2)
      await a.manager.clear('helper')
      const replacement = await a.turns.profileId('helper', one.id)
      expect(
        (
          await a.manager.run(
            { profileId: replacement!, chatId: one.id, turnId: randomUUID() },
            { op: 'observe' },
            new AbortController().signal
          )
        ).ok
      ).toBe(true)
      expect(adapter.instances).toHaveLength(3)
      expect(scan).toHaveBeenCalledTimes(1)
    } finally {
      release()
      scan.mockRestore()
    }
  })
  it.skipIf(process.platform !== 'linux')(
    'does not exempt a stale ownership record merely because its parent is this server process',
    async () => {
      const orphan = join(root, 'browsers', randomUUID())
      await mkdir(orphan, { recursive: true })
      const self = await identity(process.pid)
      await writeOwner({ version: 2, profile: orphan, state: 'launching', token: randomUUID(), worker: self, parent: self, processes: [] })
      const a = await start(),
        chat = await chats.create('helper', root)
      const profileId = await a.turns.profileId('helper', chat.id)
      expect(
        (
          await a.manager.run(
            { profileId: profileId!, chatId: chat.id, turnId: randomUUID() },
            { op: 'observe' },
            new AbortController().signal
          )
        ).ok
      ).toBe(false)
      expect(adapter.instances).toHaveLength(0)
    }
  )
})

it('resolves agent uploads only from user attachments explicitly present in its authorized chat', async () => {
  const attachments = new AttachmentStore(join(root, 'attachments'), randomUUID)
  const stage = await attachments.stageBytes('attached.txt', Buffer.from('attached bytes'))
  if (!stage.ok) throw Error('fixture stage failed')
  const chat = await chats.create('helper', root),
    other = await chats.create('helper', root)
  await attachments.commit(chat.id, [stage.attachment.id])
  await chats.saveItems(chat.id, [{ type: 'user', id: 'user', ts: 1, text: 'attached', attachments: [stage.attachment] }])
  const orphan = await attachments.stageBytes('orphan.txt', Buffer.from('not attached'))
  if (!orphan.ok) throw Error('fixture stage failed')
  await attachments.commit(chat.id, [orphan.attachment.id])
  app = await createBrowserApplication({ dataDir: root, agents, chats, feed, adapter, attachments })
  const profileId = await app.turns.profileId('helper', chat.id),
    owner = { profileId: profileId!, chatId: chat.id, turnId: 'turn', generation: 'g' }
  expect(await app.files.resolveUpload(owner, [stage.attachment.id])).toEqual([await attachments.chatFile(chat.id, stage.attachment.id)])
  await expect(app.files.resolveUpload(owner, [orphan.attachment.id])).rejects.toThrow('unavailable')
  await expect(app.files.resolveUpload({ ...owner, chatId: other.id }, [stage.attachment.id])).rejects.toThrow('unavailable')
})

it.skipIf(process.platform !== 'linux')(
  'removes orphan download scratch only after global ownership recovery and preserves unrelated directories',
  async () => {
    const { readdir, symlink } = await import('node:fs/promises')
    const { recoverBrowserProfiles } = await import('../../src/core/browser/browserProcess')
    const browsers = join(root, 'browsers'),
      orphan = join(browsers, randomUUID()),
      scratch = join(orphan, '.downloads-' + randomUUID())
    await mkdir(scratch, { recursive: true })
    await writeFile(join(scratch, 'guid.crdownload'), 'partial')
    await mkdir(join(orphan, '.downloads-unrelated'))
    await symlink(root, join(orphan, '.downloads-' + randomUUID()))
    await recoverBrowserProfiles(browsers)
    expect(await readdir(orphan)).not.toContain(scratch.split('/').at(-1))
    expect(await readdir(orphan)).toContain('.downloads-unrelated')
    expect(await readFile(join(root, 'agents', 'helper.md'), 'utf8')).toContain('helper')
  }
)
it.skipIf(process.platform !== 'linux').each(['live', 'unconfirmed'] as const)(
  'keeps %s owner download scratch until recovery confirms cleanup',
  async (state) => {
    const { recoverBrowserProfiles } = await import('../../src/core/browser/browserProcess')
    const browsers = join(root, 'browsers'),
      orphan = join(browsers, randomUUID()),
      scratch = join(orphan, '.downloads-' + randomUUID())
    await mkdir(scratch, { recursive: true })
    await writeFile(join(scratch, 'guid.crdownload'), 'partial')
    const self = await identity(process.pid)
    await writeOwner({
      version: 2,
      profile: orphan,
      state: state === 'live' ? 'ready' : 'unconfirmed',
      token: randomUUID(),
      worker: state === 'live' ? self : { pid: 2147483646, start: '1' },
      parent: self,
      processes: []
    })
    await expect(recoverBrowserProfiles(browsers)).rejects.toThrow()
    expect(await readFile(join(scratch, 'guid.crdownload'), 'utf8')).toBe('partial')
  }
)
// chmod 0 cannot lock a folder on Windows.
it.skipIf(process.platform === 'win32')('keeps text work usable when browser file staging cannot be initialized', async () => {
  const { chmod } = await import('node:fs/promises')
  const staging = join(root, 'browsers', 'files')
  await mkdir(staging, { recursive: true })
  await mkdir(join(staging, 'blocked'))
  await writeFile(join(staging, 'blocked', 'partial'), 'partial')
  await chmod(join(staging, 'blocked'), 0)
  try {
    const a = await start(),
      chat = await chats.create('helper', root)
    expect(await a.turns.profileId('helper', chat.id)).toBeNull()
    expect(adapter.instances).toHaveLength(0)
  } finally {
    await chmod(join(staging, 'blocked'), 0o700).catch(() => {})
  }
})
