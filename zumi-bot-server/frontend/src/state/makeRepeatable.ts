import { engineOfAgent } from '@zumibot/shared/engine'
import { isGroup, type AgentSummary, type ChatMeta } from '@zumibot/shared/types'
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import { pathFor } from './route'

// Make repeatable: a finished chat handed to Zumi Bot's /make-repeatable command (docs/architecture/zumi-bot-automations.md).

export type RepeatableKind = 'command' | 'skill' | 'routine' | 'workflow'
/** A menu pick: one kind, or "Let Zumi Bot choose". */
export type RepeatablePick = RepeatableKind | 'any'
export const MAKE_REPEATABLE = 'make-repeatable'

const ALL: readonly RepeatableKind[] = ['command', 'skill', 'routine', 'workflow']

/** Kinds the menu offers for the chat, in menu order; empty = no button. A kind that cannot work is left out, not refused later. */
export function repeatableKinds(chat: ChatMeta, agents: readonly AgentSummary[]): RepeatableKind[] {
  if (chat.replyAt === undefined) return []
  if (isGroup(chat)) return [...ALL]
  if (chat.agentName === ZUMI_BOT_NAME) return []
  const agent = agents.find((a) => a.name === chat.agentName)
  // A deleted agent can still get a command once it is back; nothing else can be checked.
  if (!agent) return ['command']
  switch (engineOfAgent(agent)) {
    case 'claude':
      return [...ALL]
    // Codex and ACP agents do not load Claude Code skills.
    case 'codex':
    case 'acp':
      return ['command', 'routine', 'workflow']
    // Zumi Bot never puts a remote agent in a routine or workflow, and it loads no skills.
    case 'ag-ui':
      return ['command']
  }
}

/** The button works: something to offer, and no reply running. */
export function canMakeRepeatable(chat: ChatMeta, agents: readonly AgentSummary[]): boolean {
  return !chat.inFlight && repeatableKinds(chat, agents).length > 0
}

/** "Let Zumi Bot choose" needs more than one kind to choose from. */
export const canChoose = (kinds: readonly RepeatableKind[]): boolean => kinds.length > 1

/** What goes to Zumi Bot. It must start with the command, or the server drops the pick and sends it as plain text. */
export function repeatableText(pick: RepeatablePick, chat: Pick<ChatMeta, 'id'>, offered: readonly RepeatableKind[]): string {
  const kind = pick === 'any' ? `any (${offered.join(', ')})` : pick
  return `/${MAKE_REPEATABLE} ${kind} ${pathFor(chat.id)}`
}

/**
 * The text a pick sends, checked against the chat as it is now, or null to send nothing: the chat is gone, a reply started
 * after the menu opened (the sidebar's menu holds the copy from when it opened), or the kind is not offered.
 */
export function repeatableRequest(
  chatId: string,
  chats: readonly ChatMeta[],
  agents: readonly AgentSummary[],
  pick: RepeatablePick
): string | null {
  const chat = chats.find((c) => c.id === chatId)
  if (!chat || !canMakeRepeatable(chat, agents)) return null
  const kinds = repeatableKinds(chat, agents)
  if (pick === 'any' ? !canChoose(kinds) : !kinds.includes(pick)) return null
  return repeatableText(pick, chat, kinds)
}
