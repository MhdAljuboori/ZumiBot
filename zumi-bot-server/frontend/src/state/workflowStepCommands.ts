import type { CommandPick } from '@zumibot/shared/commands'
import { isGroup, type AgentSummary, type ChatMeta } from '@zumibot/shared/types'
import { roomFromAgents, type Step } from '@zumibot/shared/workflows'
import { keepPick } from './commandInput'

// What a step's prompt `/` menu and its Keep and Room-source controls need, kept apart from the components.

/** Whose commands a step's prompt `/` menu lists, and whether it lists them under each agent (a room). Other steps run no agent command. */
export function stepCommandAgents(
  step: Step,
  agents: readonly AgentSummary[],
  chats: readonly ChatMeta[]
): { agents: AgentSummary[]; grouped: boolean } {
  const named = (names: readonly string[]): AgentSummary[] => names.flatMap((n) => agents.filter((a) => a.name === n))
  switch (step.kind) {
    case 'agent':
    case 'foreach':
      return { agents: named(step.agent ? [step.agent] : []), grouped: false }
    case 'room': {
      if (roomFromAgents(step)) return { agents: named(step.members), grouped: true }
      const room = chats.find((c) => c.id === step.room)
      return { agents: room && isGroup(room) ? named(room.group.members) : [], grouped: true }
    }
    case 'chat': {
      const chat = chats.find((c) => c.id === step.chat)
      if (!chat) return { agents: [], grouped: false }
      return isGroup(chat)
        ? { agents: named(chat.group.members), grouped: true }
        : { agents: named(chat.agentName ? [chat.agentName] : []), grouped: false }
    }
    default:
      return { agents: [], grouped: false }
  }
}

/** The prompt changed: the saved `command` stays only while the prompt still starts with its name (a stale pick would be dropped by the parser anyway). */
export function withPrompt<S extends Step>(step: S, prompt: string): S {
  if (!('prompt' in step)) return step
  const out: Record<string, unknown> = { ...step, prompt }
  const command: CommandPick | null = keepPick(prompt, 'command' in step ? (step.command ?? null) : null)
  if (command === null) delete out.command
  else out.command = command
  return out as unknown as S
}

/** A step's Keep switch. Turning it off drops what only a kept chat has: its title and a room's sidebar section. */
export function withKeep<S extends Step>(step: S, keep: boolean): S {
  const out: Record<string, unknown> = { ...step }
  if (keep) out.keep = true
  else {
    delete out.keep
    delete out.title
    delete out.section
  }
  return out as unknown as S
}

export type RoomSource = 'copy' | 'agents'

export const roomSourceOf = (step: Extract<Step, { kind: 'room' }>): RoomSource => (roomFromAgents(step) ? 'agents' : 'copy')

/** Switching a Room step's source clears the other source's keys: a copied room has no members, role or folder; a new room has no template. */
export function withRoomSource(step: Extract<Step, { kind: 'room' }>, source: RoomSource): Extract<Step, { kind: 'room' }> {
  if (roomSourceOf(step) === source) return step
  const out: Record<string, unknown> = { ...step }
  if (source === 'agents') Object.assign(out, { room: '', members: [], role: '', cwd: '' })
  else {
    for (const k of ['members', 'role', 'cwd']) delete out[k]
  }
  return out as unknown as Extract<Step, { kind: 'room' }>
}
