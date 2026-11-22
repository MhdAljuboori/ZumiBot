import { randomUUID } from 'node:crypto'
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import { boundDesktopStatus, type DesktopHandoff, type DesktopStatus, type DesktopTarget } from '@zumibot/shared/desktop'
import type { AgentSummary } from '@zumibot/shared/types'
import type { AgentStore } from '../agents/agentStore'
import type { ChatStore } from '../store/chatStore'
import type { ItemsFeed } from '../../rpc/itemsFeed'
import type { ChatServiceDeps } from '../chat/chatService'
import { BrowserCapabilities } from '../browser/browserCapabilities'
import { BrowserProfileStore } from '../browser/profileStore'
import { loadDesktopConfig } from './config'
import { DesktopManager } from './desktopManager'
import { serveDesktopIpc } from './desktopIpc'
import { createProcessAdapter } from './desktopProcess'
import { resolveDesktopRuntime, type DesktopRuntime } from './desktopRuntime'
import type { DesktopAdapter } from './types'

/** What one logical turn gets: nothing, only the "unavailable" prompt, or this profile's desktop. */
export type DesktopPlan = 'off' | 'unavailable' | { profileId: string }

/** Opt-in per agent; a built-in agent never gets a desktop, whatever its file says. */
const computerUse = (agent: AgentSummary | undefined): agent is AgentSummary =>
  !!agent && agent.error === null && !agent.builtIn && agent.name !== ZUMI_BOT_NAME && agent.computerUse === true

/** Authorization and process wiring for agent desktops; nothing starts until a desktop tool call or a viewer. */
export async function createDesktopApplication(d: {
  dataDir: string
  agents: Pick<AgentStore, 'list'>
  chats: Pick<ChatStore, 'get' | 'loadItems'>
  feed: ItemsFeed
  adapter?: DesktopAdapter
  runtime?: DesktopRuntime
}) {
  const config = loadDesktopConfig(process.env)
  // Programs are looked up once, like the adapter that launches them: an install takes effect at the next start.
  const runtime = d.runtime ?? resolveDesktopRuntime()
  const missing = process.platform === 'linux' ? [...runtime.missing] : ['Linux']
  const profiles = new BrowserProfileStore(d.dataDir, randomUUID, 'desktops')
  let available = true
  try {
    await profiles.load()
  } catch {
    available = false
  }
  const privateOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation()
    } catch {
      throw new Error('Desktop unavailable')
    }
  }
  const summaryOf = async (agent: string) => (await d.agents.list()).find((a) => a.name === agent && a.error === null)
  const requireAgent = async (agent: string): Promise<AgentSummary> => {
    const summary = await summaryOf(agent)
    if (!summary) throw new Error('Desktop agent is unavailable')
    return summary
  }
  const requireMember = async (target: DesktopTarget) => {
    if (target.requestId && !target.chatId) throw new Error('Desktop request requires its chat')
    if (target.chatId) {
      const chat = await d.chats.get(target.chatId)
      if (!chat || !(chat.group ? chat.group.members.includes(target.agent) : chat.agentName === target.agent))
        throw new Error('Desktop agent is not a chat member')
    }
  }
  const handoffs = new Map<string, DesktopHandoff>()
  const resolveTarget = async (target: DesktopTarget) => {
    if (!computerUse(await requireAgent(target.agent))) throw new Error('Computer use is off for this agent')
    await requireMember(target)
    if (!available) throw new Error('Desktop unavailable')
    const profile = await privateOperation(() => profiles.ensure(target.agent))
    if (target.requestId) {
      const { items } = await d.feed.snapshot(target.chatId!, () => d.chats.loadItems(target.chatId!))
      // Only a desktop card: a browser card shares the type, and its id never answers a desktop request.
      const item = items.find((i) => i.type === 'browser-action' && i.surface === 'desktop' && i.id === target.requestId)
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
        throw new Error('Stale desktop action request')
      }
    }
    return { ...profile, agent: target.agent }
  }
  const manager = new DesktopManager({
    profiles,
    adapter: d.adapter ?? createProcessAdapter(runtime),
    config,
    now: Date.now,
    newId: randomUUID,
    resolveTarget,
    onHandoff: async (handoff) => {
      if (handoff.status === 'pending') handoffs.set(handoff.id, { ...handoff })
      else handoffs.delete(handoff.id)
    }
  })
  let ipc: Awaited<ReturnType<typeof serveDesktopIpc>>
  // Its own capability store: a browser capability must never authorize a desktop call, nor the reverse.
  try {
    ipc = await serveDesktopIpc({ manager, capabilities: new BrowserCapabilities(), runtime })
  } catch (error) {
    await manager.close()
    await profiles.close()
    throw error
  }
  const turns: NonNullable<ChatServiceDeps['desktopTurns']> = {
    async plan(agent, chatId) {
      if (!computerUse(await summaryOf(agent))) return 'off'
      await requireMember({ agent, chatId })
      if (missing.length > 0 || !available) return 'unavailable'
      try {
        return { profileId: (await profiles.ensure(agent)).id }
      } catch {
        available = false
        return 'unavailable'
      }
    },
    create: (owner, onHandoff, o) => ipc.createDesktopTurn(owner, onHandoff, o)
  }
  const quiet = (agent: string, state: 'off' | 'unavailable', extra: Partial<DesktopStatus> = {}): DesktopStatus =>
    boundDesktopStatus({
      agent,
      profileId: '',
      generation: '',
      state,
      control: 'agent',
      pendingRequestId: null,
      error: null,
      width: config.width,
      height: config.height,
      busy: false,
      ...extra
    })
  let closing: Promise<void> | undefined
  return {
    manager,
    turns,
    resolveTarget,
    agents: () => (available ? profiles.agents() : []),
    /** Never starts a desktop; an agent without computer use is 'off' and gets no profile. */
    async status(agent: string): Promise<DesktopStatus> {
      if (!computerUse(await requireAgent(agent))) return quiet(agent, 'off')
      if (missing.length > 0) return quiet(agent, 'unavailable', { missing: [...missing] })
      if (!available) return quiet(agent, 'unavailable', { error: 'Desktop data could not be read' })
      return privateOperation(() => manager.status(agent))
    },
    /** Also for an agent whose computer use was turned off since: its data stays until cleared. */
    async clear(agent: string) {
      const summary = await requireAgent(agent)
      if (summary.builtIn || agent === ZUMI_BOT_NAME) throw new Error('Desktop agent is unavailable')
      if (!available) throw new Error('Desktop unavailable')
      // No mapping means no desktop and no data: clearing must not make a profile.
      if (!profiles.agents().includes(agent)) return
      await privateOperation(() => manager.clear(agent))
    },
    async renameAgent(from: string, to: string) {
      if (available) await privateOperation(() => manager.renameAgent(from, to))
    },
    async removeAgents(names: readonly string[]) {
      if (available) await privateOperation(() => manager.removeAgents(names))
    },
    close(): Promise<void> {
      return (closing ??= (async () => {
        // Revoking capabilities and stopping desktops go together, so neither waits behind a pending handoff.
        const results = await Promise.allSettled([manager.close(), ipc.close()])
        await profiles.close()
        for (const result of results) if (result.status === 'rejected') throw new Error('Desktop cleanup could not be confirmed')
      })())
    }
  }
}

export type DesktopApplication = Awaited<ReturnType<typeof createDesktopApplication>>
