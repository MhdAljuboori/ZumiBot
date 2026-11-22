import { BrowserFiles } from './browserFiles'
import type { BrowserShots } from './browserShots'
import type { AttachmentStore } from '../attachments/attachmentStore'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { AgentStore } from '../agents/agentStore'
import type { ChatStore } from '../store/chatStore'
import type { ItemsFeed } from '../../rpc/itemsFeed'
import type { ChatServiceDeps } from '../chat/chatService'
import { BrowserProfileStore } from './profileStore'
import { BrowserManager, type BrowserVault } from './browserManager'
import { BrowserCapabilities } from './browserCapabilities'
import { serveBrowserIpc } from './browserIpc'
import { createWorkerAdapter } from './workerAdapter'
import { resolveBrowserRuntime, type BrowserRuntime } from './browserRuntime'
import { loadBrowserConfig } from './config'
import { recoverBrowserProfiles } from './browserProcess'
import type { BrowserAdapter, BrowserTarget, BrowserHandoff } from './types'

/** Application authorization and process wiring; no Playwright import or startup launch. */
export async function createBrowserApplication(d: {
  dataDir: string
  agents: Pick<AgentStore, 'list'>
  chats: Pick<ChatStore, 'get' | 'loadItems'>
  feed: ItemsFeed
  attachments?: AttachmentStore
  shots?: BrowserShots
  adapter?: BrowserAdapter
  runtime?: BrowserRuntime
  vault?: BrowserVault
}) {
  const profiles = new BrowserProfileStore(d.dataDir)
  let available = true
  try {
    await profiles.load()
  } catch {
    available = false
  }
  const requireMetadata = () => {
    if (!available) throw new Error('Browser unavailable')
  }
  const privateOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation()
    } catch {
      throw new Error('Browser unavailable')
    }
  }
  const requireAgent = async (agent: string) => {
    if (!(await d.agents.list()).some((a) => a.name === agent && a.error === null)) throw new Error('Browser agent is unavailable')
  }
  const validate = async (target: BrowserTarget) => {
    await requireAgent(target.agent)
    if (target.requestId && !target.chatId) throw new Error('Browser request requires its chat')
    if (target.chatId) {
      const chat = await d.chats.get(target.chatId)
      if (!chat || !(chat.group ? chat.group.members.includes(target.agent) : chat.agentName === target.agent))
        throw new Error('Browser agent is not a chat member')
    }
  }
  // A rejected recovery remains fail-closed for this server lifetime. Successful recovery
  // happens before all concurrent first launches, never against workers this manager owns.
  let recovery: Promise<void> | undefined
  const recover = () => (recovery ??= recoverBrowserProfiles(join(d.dataDir, 'browsers')))
  const runtime = d.runtime ?? resolveBrowserRuntime()
  const adapter = d.adapter ?? createWorkerAdapter(runtime)
  const files = new BrowserFiles(join(d.dataDir, 'browsers', 'files'), {
    attached: async (owner, id) => {
      const profile = await profiles.byId(owner.profileId)
      if (!profile || !d.attachments) return null
      await validate({ agent: profile.agent, chatId: owner.chatId })
      const { items } = await d.feed.snapshot(owner.chatId, () => d.chats.loadItems(owner.chatId))
      if (!items.some((i) => i.type === 'user' && i.attachments?.some((a) => a.id === id))) return null
      return d.attachments.chatFile(owner.chatId, id)
    }
  })
  try {
    if (available) await files.clear()
  } catch {
    available = false
  }
  const handoffs = new Map<string, BrowserHandoff>()
  const resolveTarget = async (target: BrowserTarget) => {
    await validate(target)
    requireMetadata()
    const profile = await privateOperation(() => profiles.ensure(target.agent))
    if (target.requestId) {
      const { items } = await d.feed.snapshot(target.chatId!, () => d.chats.loadItems(target.chatId!))
      // A desktop handoff shares the card type; its id never answers a browser request.
      const item = items.find((i) => i.type === 'browser-action' && i.surface === undefined && i.id === target.requestId)
      const status = await manager.status(target.agent)
      const live = handoffs.get(target.requestId)
      if (
        !item ||
        item.type !== 'browser-action' ||
        item.agent !== target.agent ||
        item.handoff.agent !== target.agent ||
        item.handoff.id !== target.requestId ||
        item.handoff.chatId !== target.chatId ||
        item.handoff.profileId !== profile.id ||
        item.handoff.status !== 'pending' ||
        item.handoff.generation !== status.generation ||
        status.pendingRequestId !== target.requestId ||
        !live ||
        live.turnId !== item.handoff.turnId ||
        live.chatId !== target.chatId ||
        live.agent !== target.agent ||
        live.profileId !== profile.id ||
        live.generation !== item.handoff.generation
      ) {
        throw new Error('Stale browser action request')
      }
    }
    return { ...profile, agent: target.agent }
  }
  const manager = new BrowserManager({
    profiles,
    files,
    adapter: {
      launch: async (path, config, hooks) => {
        await recover()
        return adapter.launch(path, config, hooks)
      }
    },
    config: loadBrowserConfig(process.env),
    now: Date.now,
    newId: randomUUID,
    resolveTarget,
    vault: d.vault,
    shots: d.shots,
    onHandoff: async (handoff) => {
      if (handoff.status === 'pending') handoffs.set(handoff.id, { ...handoff })
      else handoffs.delete(handoff.id)
    }
  })
  let ipc: Awaited<ReturnType<typeof serveBrowserIpc>>
  try {
    ipc = await serveBrowserIpc({ manager, capabilities: new BrowserCapabilities(), runtime })
  } catch (error) {
    await manager.close()
    await files.close()
    throw error
  }
  const turns: NonNullable<ChatServiceDeps['browserTurns']> = {
    async profileId(agent, chatId) {
      await validate({ agent, chatId })
      if (!available) return null
      try {
        return (await profiles.ensure(agent)).id
      } catch {
        available = false
        return null
      }
    },
    create: (owner, onHandoff) => ipc.createBrowserTurn(owner, onHandoff)
  }
  let closing: Promise<void> | undefined
  return {
    manager,
    turns,
    resolveTarget,
    files,
    agents: () => (available ? profiles.agents() : []),
    async status(agent: string) {
      await requireAgent(agent)
      requireMetadata()
      return privateOperation(() => manager.status(agent))
    },
    async clear(agent: string) {
      await requireAgent(agent)
      requireMetadata()
      await privateOperation(async () => {
        await recover()
        await manager.clear(agent)
      })
    },
    async renameAgent(from: string, to: string) {
      if (available) await privateOperation(() => manager.renameAgent(from, to))
    },
    async removeAgents(names: readonly string[]) {
      if (available) await privateOperation(() => manager.removeAgents(names))
    },
    close(): Promise<void> {
      return (closing ??= (async () => {
        // Abort manager work immediately, alongside IPC revocation; persistence callbacks
        // remain installed until each endTurn has completed.
        const results = await Promise.allSettled([manager.close(), ipc.close()])
        await profiles.close()
        await files.close()
        for (const result of results) if (result.status === 'rejected') throw new Error('Browser cleanup could not be confirmed')
      })())
    }
  }
}
