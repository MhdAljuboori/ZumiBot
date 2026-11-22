import { groupKey } from '@zumibot/shared/sidebarLayout'
import type { Engine, EngineCaps } from '@zumibot/shared/engine'
import type { AgentSummary, ChatMeta, WorkflowLink } from '@zumibot/shared/types'
import type { StepRule } from '@zumibot/shared/workflows'
import type { ChatService } from '../chat/chatService'
import { cloneRoom } from '../chat/roomClone'
import { refuseZumiBot, refuseCodexMembers } from '../groupMembers'
import type { ChatStore } from '../store/chatStore'
import { agentProblem } from './workflowAgentSteps'

export const ROOM_NOT_FOUND = 'Room not found'
export const NOT_A_ROOM = 'This chat is not a room'

type EngineCapsFn = (e: Engine) => EngineCaps

export interface RoomTarget {
  slotId: string
  room: string
  rules: StepRule[]
  title: string
  // Set when the step builds its room from agents (room is then ''); section: where a kept room goes first.
  agents?: { members: string[]; role: string; cwd: string }
  section?: string
  earlierChat?: string
  link: WorkflowLink
}

export interface RoomCopyDeps {
  store: Pick<ChatStore, 'get' | 'createGroup' | 'update' | 'remove'>
  allowed: Pick<ChatService, 'copyAllowed'>
  agents(): Promise<AgentSummary[]>
  zumiBot: string
  caps?: EngineCapsFn
  sectionOf(chatId: string): Promise<string | null>
  placeRoom?(chatId: string, sectionId: string): Promise<void>
  now(): number
}

/** Why a template room cannot be copied: it is gone, it is no room, or a member's agent is missing or broken. Null when it can. */
export function roomProblem(template: ChatMeta | null, agents: AgentSummary[], zumiBot: string): string | null {
  if (!template) return ROOM_NOT_FOUND
  if (!template.group) return NOT_A_ROOM
  for (const m of template.group.members) {
    const problem = agentProblem(m, agents, zumiBot)
    if (problem) return problem
  }
  return null
}

/** A fresh copy of the template room for one run (what Clone room › Start over makes), marked as the workflow's. */
export async function copyRoom(d: RoomCopyDeps, t: RoomTarget): Promise<{ chatId: string } | { error: string }> {
  const template = await d.store.get(t.room)
  if (!template) return { error: ROOM_NOT_FOUND }
  if (!template.group) return { error: NOT_A_ROOM }
  const agents = await d.agents()
  // Before the member check, so a Zumi Bot member gets the room rules' own words.
  try {
    refuseZumiBot(template.group.members)
    refuseCodexMembers(template.group.members, agents, d.caps)
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
  const problem = roomProblem(template, agents, d.zumiBot)
  if (problem) return { error: problem }

  const copy = await cloneRoom({ store: d.store, allowed: d.allowed, now: d.now }, t.room, t.title, null)
  try {
    await d.store.update(copy.id, { workflow: t.link, ...(t.rules.length ? { workflowRules: t.rules } : {}) })
  } catch (err) {
    await d.store.remove(copy.id).catch(() => undefined)
    throw err
  }
  await place(d, copy.id, t.section ?? (await d.sectionOf(groupKey(t.room))))
  return { chatId: copy.id }
}

// Only where it shows: a failed sidebar write must not fail the run, which goes on in the room either way.
async function place(d: RoomCopyDeps, chatId: string, section: string | null | undefined): Promise<void> {
  if (!section || !d.placeRoom) return
  try {
    await d.placeRoom(chatId, section)
  } catch (err) {
    console.error('placing a workflow room failed:', err instanceof Error ? err.message : err)
  }
}

/** A fresh room of the step's own agents, role and folder (what a routine's new-group target makes), marked as the workflow's. */
export async function newRoom(
  d: RoomCopyDeps,
  t: RoomTarget & { agents: NonNullable<RoomTarget['agents']> }
): Promise<{ chatId: string } | { error: string }> {
  const { members, role, cwd } = t.agents
  const agents = await d.agents()
  // Zumi Bot first, so it gets the room rules' own words rather than a missing-agent text.
  try {
    refuseZumiBot(members)
    refuseCodexMembers(members, agents, d.caps)
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
  for (const m of members) {
    const problem = agentProblem(m, agents, d.zumiBot)
    if (problem) return { error: problem }
  }

  const room = await d.store.createGroup(members, cwd, role)
  try {
    await d.store.update(room.id, { title: t.title, workflow: t.link, ...(t.rules.length ? { workflowRules: t.rules } : {}) })
  } catch (err) {
    await d.store.remove(room.id).catch(() => undefined)
    throw err
  }
  // A room from agents has no template to follow: no section unless the kept step names one.
  await place(d, room.id, t.section)
  return { chatId: room.id }
}
