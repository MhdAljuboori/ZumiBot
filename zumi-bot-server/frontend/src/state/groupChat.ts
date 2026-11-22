// Pure helpers for the group chat screens.
import { engineCaps, type Engine, type EngineCaps } from '@zumibot/shared/engine'
import { displayName } from '@zumibot/shared/frontmatter'
import { maskCode, splitMentions, type MentionSegment } from '@zumibot/shared/mentions'
import { PLAN_TOOL } from '@zumibot/shared/plans'
import { QUESTION_TOOL } from '@zumibot/shared/questions'
import { GROUP_MIN_MEMBERS, PASS_MARKER, type AgentSummary, type ChatItem, type ChatMeta, type GroupInfo } from '@zumibot/shared/types'
import { joinsRooms } from './agentEngine'
import { endsInToolItems, type AgentItem } from './messageGroups'

export const GROUP_LABEL = 'Message the group'
export const GROUP_PLACEHOLDER = 'Message the group… type @ to mention'

/** The agent behind a handle: a valid one first (a broken duplicate can share the name), else any. */
export function findAgent(agents: readonly AgentSummary[], name: string): AgentSummary | undefined {
  return agents.find((a) => a.name === name && a.error === null) ?? agents.find((a) => a.name === name)
}

/** Stands in for a member whose agent file is gone: no color or face, and flagged so it renders greyed. */
export function missingAgent(name: string): AgentSummary {
  return { filePath: '', name, description: '', color: null, icon: null, error: 'missing', builtIn: false }
}

/** The members' agents in member order; members whose file is gone are left out. */
export function memberAgents(members: readonly string[], agents: readonly AgentSummary[]): AgentSummary[] {
  return members.flatMap((n) => findAgent(agents, n) ?? [])
}

/** The closed members picker's label. */
export const membersLabel = (n: number): string => (n === 1 ? '1 agent' : `${n} agents`)

/** The members taking a turn right now, in start order; none outside a running group. */
export function workingMembers(chat: Pick<ChatMeta, 'inFlight' | 'group'>): string[] {
  return chat.group && chat.inFlight ? chat.group.active.map((t) => t.agent) : []
}

/** A live reply that so far reads only as the start of the pass marker: hidden, since a pass is never posted. */
export const isPassPrefix = (text: string): boolean => PASS_MARKER.startsWith(text.trim())

/** splitMentions (`everyone`: for the user's own text), except that a handle inside a code span or block stays text: it never gave anyone a turn either. */
export function mentionSegments(text: string, members: readonly string[], everyone = false): MentionSegment[] {
  let pos = 0
  return splitMentions(maskCode(text), members, everyone).map((s) => {
    const len = s.kind === 'text' ? s.text.length : s.raw.length
    const original = text.slice(pos, pos + len)
    pos += len
    return s.kind === 'text' ? { kind: 'text', text: original } : s
  })
}

export interface MemberOption {
  name: string
  agent: AgentSummary | undefined // undefined: the agent file is gone
  checked: boolean
  disabled: boolean
  note: "can't join" | 'missing' | null
}

/**
 * The Members checklist: every loadable agent (Zumi Bot, and a Codex agent while Codex rooms are off, listed but
 * disabled), then any picked member that can no longer be picked, greyed but still uncheckable. An existing group's list
 * (keepMinimum) locks unchecking when it would leave fewer than the minimum; the new-chat list never locks, since Send
 * waits for enough members anyway.
 */
export function memberOptions(
  agents: readonly AgentSummary[],
  selected: readonly string[],
  keepMinimum: boolean,
  caps: (e: Engine) => EngineCaps = engineCaps
): MemberOption[] {
  const locked = keepMinimum && selected.length <= GROUP_MIN_MEMBERS
  const pickable = agents.filter((a) => a.error === null)
  const options: MemberOption[] = pickable.map((a) =>
    !joinsRooms(a, caps)
      ? { name: a.name, agent: a, checked: false, disabled: true, note: "can't join" }
      : { name: a.name, agent: a, checked: selected.includes(a.name), disabled: locked && selected.includes(a.name), note: null }
  )
  for (const name of selected) {
    if (pickable.some((a) => a.name === name)) continue
    const agent = agents.find((a) => a.name === name)
    options.push({ name, agent, checked: true, disabled: locked, note: agent ? null : 'missing' })
  }
  return options
}

export const toggleMember = (selected: readonly string[], name: string): string[] =>
  selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name]

/** A card the agent addresses to the user (a question, a plan): its member waits on the user's answer, not on approval. */
const asksUser = (toolName: string): boolean => toolName === QUESTION_TOOL || toolName === PLAN_TOOL

/** An item a running turn wrote: the backend appends the turn to the thread in one piece when it ends. */
export const isLive = (i: ChatItem): boolean => 'turn' in i && i.turn !== undefined

/** The finished thread: the items no running turn holds. */
export const threadItems = (items: readonly ChatItem[]): ChatItem[] => items.filter((i) => !isLive(i))

/** What a running turn is doing: at work, or waiting on the user. */
export type LiveState = 'working' | 'approval' | 'asked'

/** One running turn of a room, drawn as its own block under the finished thread. */
export interface LiveTurn {
  agent: string
  turn: string
  items: AgentItem[]
  /** working: the member is at it; approval: waits on a permission, browser or vault card; asked: on a question or plan card. */
  state: LiveState
  /** Listed as working in the room: false for a turn that ended but whose move into the thread has not landed yet. */
  active: boolean
  compacting: boolean
}

const isAgentItem = (i: ChatItem): i is AgentItem =>
  i.type === 'assistant' ||
  i.type === 'thinking' ||
  i.type === 'tool' ||
  i.type === 'approval' ||
  i.type === 'browser-action' ||
  i.type === 'vault-approval'

// A pass is never posted: the turn's end takes it out, so the block never shows it either.
const isPassReply = (i: AgentItem): boolean => i.type === 'assistant' && i.text.trim() === PASS_MARKER

function liveState(items: readonly AgentItem[]): LiveState {
  if (
    items.some(
      (i) =>
        (i.type === 'browser-action' && i.handoff.status === 'pending') || (i.type === 'vault-approval' && i.request.status === 'pending')
    )
  )
    return 'approval'
  const waiting = [...items]
    .reverse()
    .find((i): i is Extract<AgentItem, { type: 'approval' }> => i.type === 'approval' && i.status === 'pending')
  if (!waiting) return 'working'
  return asksUser(waiting.toolName) ? 'asked' : 'approval'
}

/**
 * What a running turn's finished messages offer: Copy, Reply, a reaction, Mark unread and Export keep the item's id when
 * the turn moves into the thread. Fork is left out (the server refuses an item still stamped with its turn), and Resend
 * too: the turn has not ended, so there is no reply yet to replace.
 */
export function liveActions<H extends { resendOf: (itemId: string) => string | null; onFork?: unknown }>(
  handlers: H
): Omit<H, 'onFork'> {
  const { onFork: _fork, ...rest } = handlers
  return { ...rest, resendOf: () => null }
}

/**
 * The room's running turns, each one block under the finished thread: the members working, in start order, then any
 * other turn still stamped on items (ended, its move into the thread not pushed yet), in the order it first wrote.
 * A turn's notices and errors wait for its end, as they always did; a live block holds what an agent group draws.
 */
export function liveTurns(group: Pick<GroupInfo, 'active'> | undefined, inFlight: boolean, items: readonly ChatItem[]): LiveTurn[] {
  if (!group) return []
  const byTurn = new Map<string, AgentItem[]>()
  for (const i of items) {
    if (!isLive(i) || !isAgentItem(i) || isPassReply(i)) continue
    const turn = (i as { turn: string }).turn
    const list = byTurn.get(turn)
    if (list) list.push(i)
    else byTurn.set(turn, [i])
  }
  const out: LiveTurn[] = []
  const active = inFlight ? group.active : []
  for (const t of active) {
    const mine = byTurn.get(t.turn) ?? []
    byTurn.delete(t.turn)
    out.push({ agent: t.agent, turn: t.turn, items: mine, state: liveState(mine), active: true, compacting: t.compacting === true })
  }
  for (const [turn, mine] of byTurn) {
    const agent = mine.find((i) => i.agent !== undefined)?.agent
    if (agent === undefined) continue
    out.push({ agent, turn, items: mine, state: liveState(mine), active: false, compacting: false })
  }
  return out
}

/**
 * How a live block's tail reads, as a single chat's does: the streamed text (a reply that so far reads only as the pass
 * marker stays hidden), else a spinning tool run while tools are its latest output, else the "Working…" line. A turn
 * waiting on the user shows neither: its card says so.
 */
export function liveTail(
  t: Pick<LiveTurn, 'items' | 'state' | 'active' | 'compacting'>,
  streamed: string
): { streaming: string; thinking: boolean; showWorking: boolean } {
  const streaming = t.active && !isPassPrefix(streamed) ? streamed : ''
  const quiet = t.active && t.state === 'working' && streaming === ''
  const thinking = quiet && !t.compacting && endsInToolItems(t.items)
  return { streaming, thinking, showWorking: quiet && !thinking }
}

/** What the Continue pill under a paused notice sends. */
export const CONTINUE_TEXT = 'Continue'

/** The members stopped at the hop cap and nobody has written since: the paused notice is the last item. */
export const pausedAtEnd = (items: readonly ChatItem[]): boolean => {
  const last = items[items.length - 1]
  return last?.type === 'notice' && last.kind === 'paused'
}

/** A member queued for a turn and not working yet, and what it waits for. */
export interface QueuedMember {
  agent: string
  text: string
}

/** The room's queued members not working yet: "up next", or "waits for" the members it follows. */
export function queuedMembers(group: Pick<GroupInfo, 'active' | 'queue'>, agents: readonly AgentSummary[]): QueuedMember[] {
  const name = (n: string): string => {
    const a = findAgent(agents, n)
    return a ? displayName(a.name) : n
  }
  const working = new Set(group.active.map((t) => t.agent))
  const out: QueuedMember[] = []
  for (const e of group.queue) {
    if (working.has(e.agent) || out.some((q) => q.agent === e.agent)) continue
    const waits = e.after.filter((a) => a !== e.agent).map(name)
    out.push({ agent: e.agent, text: waits.length > 0 ? `waits for ${waits.join(', ')}` : 'up next' })
  }
  return out
}
