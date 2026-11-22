import { askHandle } from '@zumibot/shared/agentAsk'
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import { engineCaps, engineOfAgent, isRemoteAgent, type Engine, type EngineCaps } from '@zumibot/shared/engine'
import type { SideQuestion } from '@zumibot/shared/btw'
import type { AgentSummary, AskedFrom, ChatItem, ChatMeta } from '@zumibot/shared/types'
import { mentionLabel } from './agentNames'
import { chatTitle } from './sidebarTree'

type ToolItem = Extract<ChatItem, { type: 'tool' }>
type ApprovalItem = Extract<ChatItem, { type: 'approval' }>

/** The note over an asked chat: who talks, and the chat it began in (null once that chat is gone). */
export function askedBarText(
  asked: AskedFrom,
  agentName: string,
  sourceExists: boolean,
  agents: readonly { name: string }[]
): { lead: string; source: string | null } {
  return {
    lead: `Conversation between ${mentionLabel(asked.by)} and ${mentionLabel(agentName)}, started from`,
    source: sourceExists ? chatTitle({ title: asked.fromTitle }, agents) : null
  }
}

/** The chat that agent was asked in from that source chat, if one exists. */
export function askedChatOf(chats: readonly ChatMeta[], fromChatId: string, rawHandle: string): ChatMeta | null {
  const handle = askHandle(rawHandle)
  return chats.find((c) => c.asked?.from === fromChatId && c.agentName.toLowerCase() === handle) ?? null
}

/** Who wrote a user message: the user, or the agent that asked. */
export function userAuthor(item: Extract<ChatItem, { type: 'user' }>): { kind: 'you' } | { kind: 'agent'; name: string } {
  return item.from === undefined ? { kind: 'you' } : { kind: 'agent', name: item.from }
}

export type AskStatus = 'working' | 'waiting' | 'done' | 'failed' | 'stopped'

export interface AskCardState {
  status: AskStatus
  /** The asked agent's handle, without the @. */
  target: string
  message: string
  reply: string | null
  /** The A to B chat; null before it exists (or once it is gone). */
  chatId: string | null
}

/**
 * Whether a result-less ask call is still going: the asking chat runs and no user message came after the call. Stop kills
 * the CLI, so its ask never gets a result; a later send starts a new turn that must not bring the old card back to life.
 */
export function askLive(items: readonly ChatItem[], toolId: string, sourceRunning: boolean): boolean {
  if (!sourceRunning) return false
  const at = items.findIndex((i) => i.id === toolId)
  return at >= 0 && !items.slice(at + 1).some((i) => i.type === 'user')
}

/**
 * What an ask card shows. A call with no result that is not live (see askLive) ended without one (stopped, or the
 * server restarted), so it reads Stopped rather than working forever.
 */
export function askCardState(tool: ToolItem, asked: ChatMeta | null, pendingByChat: Record<string, number>, live: boolean): AskCardState {
  const input = tool.input as { agent?: unknown; message?: unknown }
  const base = {
    target: askHandle(typeof input.agent === 'string' ? input.agent : ''),
    message: typeof input.message === 'string' ? input.message : '',
    chatId: asked?.id ?? null
  }
  if (tool.result === null || tool.result === undefined) {
    if (!live) return { ...base, status: 'stopped', reply: null }
    if (asked && (pendingByChat[asked.id] ?? 0) > 0) return { ...base, status: 'waiting', reply: null }
    return { ...base, status: 'working', reply: null }
  }
  return { ...base, status: tool.isError ? 'failed' : 'done', reply: tool.result }
}

export interface SideAskCardState {
  /** The asked agent's handle, without the @. */
  target: string
  question: string
  status: 'working' | 'done' | 'failed' | 'stopped'
  /** B's answer, or the refusal sentence when failed; null while there is no result. */
  answer: string | null
}

/** What a side_question card shows: no result is working while live, else stopped (it ended without one). */
export function sideAskCardState(tool: ToolItem, live: boolean): SideAskCardState {
  const input = tool.input as { agent?: unknown; question?: unknown }
  const base = {
    target: askHandle(typeof input.agent === 'string' ? input.agent : ''),
    question: typeof input.question === 'string' ? input.question : ''
  }
  if (tool.result === null || tool.result === undefined) return { ...base, status: live ? 'working' : 'stopped', answer: null }
  return { ...base, status: tool.isError ? 'failed' : 'done', answer: tool.result }
}

// A side entry is made just after the call starts; the grace covers a clock a little behind the item's.
const SIDE_MATCH_GRACE_MS = 5000

/** B's side entry for a call: the newest one A asked with exactly that question, at or just before the call's time. */
export function findSideEntry(list: readonly SideQuestion[], from: string, question: string, after: number): SideQuestion | null {
  // The server stores the question trimmed (askFrom), the tool input is as the agent wrote it.
  const wanted = question.trim()
  let best: SideQuestion | null = null
  for (const e of list) {
    if (e.from !== from || e.question !== wanted || e.askedAt < after - SIDE_MATCH_GRACE_MS) continue
    if (best === null || e.askedAt > best.askedAt) best = e
  }
  return best
}

/**
 * The agents a single chat's `@` menu offers: loadable ones, not the chat's own agent nor Zumi Bot nor a remote agent (the
 * ask would send its message and chat off this machine), in name order. None while
 * the chat's own agent can't ask: its engine has no `bridges` and so no ask tool (it may still be asked, as a target).
 */
export function askableAgents(agents: readonly AgentSummary[], self: string, caps: (e: Engine) => EngineCaps = engineCaps): AgentSummary[] {
  const asker = agents.find((a) => a.name === self)
  if (asker && !caps(engineOfAgent(asker)).bridges) return []
  return agents
    .filter((a) => a.error === null && a.name !== self && a.name !== ZUMI_BOT_NAME && !isRemoteAgent(a, caps))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The handles a chat's messages draw as mention chips: a room's members, or in a single chat every other agent but
 * Zumi Bot. Broken agents stay in, so an ask written before the file broke still reads as a (greyed) chip.
 */
export function mentionHandles(agents: readonly AgentSummary[], self: string, members: readonly string[] | null): string[] {
  if (members) return [...members]
  return agents.filter((a) => a.name !== self && a.name !== ZUMI_BOT_NAME).map((a) => a.name)
}

/** The approval, question and plan cards still waiting in an asked chat's items. */
export function pendingAsked(items: readonly ChatItem[] | undefined): ApprovalItem[] {
  return (items ?? []).filter((i): i is ApprovalItem => i.type === 'approval' && i.status === 'pending')
}
