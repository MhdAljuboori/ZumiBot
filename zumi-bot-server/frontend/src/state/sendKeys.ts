import type { Engine } from '@zumibot/shared/engine'

/**
 * How a message leaves the composer while a reply runs: into that reply (`steer`, read at the agent's next step), or queued
 * as a task for after it (docs/architecture/mid-turn-messages.md). On an idle chat both just send.
 */
export type SendHow = 'steer' | 'queue'

interface SendKeys {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  isComposing: boolean
}

/**
 * What a key in the composer sends, or null when it sends nothing. Enter sends into the running reply, Ctrl or Cmd+Enter
 * queues. A touch keyboard's Enter starts a new line, the way phone chat apps do: there the Send button sends (and Ctrl or
 * Cmd+Enter, for a keyboard attached to a tablet).
 */
export function sendKeyAction(e: SendKeys, coarse: boolean): SendHow | null {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return null
  if (e.ctrlKey || e.metaKey) return 'queue'
  return coarse ? null : 'steer'
}

/**
 * Whether Enter can send into this chat's running reply: a single chat on Claude. A room, or a Codex, ACP or remote agent, always
 * queues what is sent while it works (the server decides; this only keeps the UI from promising otherwise).
 */
export const takesSteers = (chat: { group?: unknown }, engine: Engine): boolean => chat.group === undefined && engine === 'claude'
