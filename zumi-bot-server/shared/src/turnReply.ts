import type { ChatItem, LimitHit } from './types'

export type TurnKind = 'ok' | 'error' | 'stopped' | 'paused' | 'interrupted' | 'capped'

export interface TurnOutcome {
  over: boolean // a later user message exists, so this turn has ended even if the chat runs the next one
  items: ChatItem[]
  reply: string | null // the turn's last agent text; null when it wrote none (never an earlier exchange's)
  error: string | null // the first error's text
  limit: LimitHit[] // the usage limits that stopped it, only when they are all that went wrong; else empty
  kind: TurnKind
}

type ErrorItem = Extract<ChatItem, { type: 'error' }>

/**
 * A message's turn as the chat stored it: the items after the user item `messageId`, up to the next user item. Only real
 * sends add user items, so the next one starts a new turn. Null when the message is not among the items (an edit or
 * resend moved it into the hidden versions). `kind` follows the routines' order: an error, then a turn limit (the room's
 * hop cap adds a `paused` notice, which is no `userPaused`), a pause, a stop, a restart.
 */
export function turnOutcome(items: readonly ChatItem[], messageId: string): TurnOutcome | null {
  const index = items.findIndex((i) => i.type === 'user' && i.id === messageId)
  if (index < 0) return null
  const next = items.findIndex((i, at) => at > index && i.type === 'user')
  const turn = items.slice(index + 1, next < 0 ? undefined : next)
  const errors = turn.filter((i): i is ErrorItem => i.type === 'error')
  const limits = errors.flatMap((e) => (e.limit ? [e.limit] : []))
  const reply = [...turn].reverse().find((i) => i.type === 'assistant')
  const noticed = (kind: string): boolean => turn.some((i) => i.type === 'notice' && i.kind === kind)
  const kind: TurnKind =
    errors.length > 0
      ? 'error'
      : noticed('paused')
        ? 'capped'
        : noticed('userPaused')
          ? 'paused'
          : noticed('stopped')
            ? 'stopped'
            : noticed('interrupted')
              ? 'interrupted'
              : 'ok'
  return {
    over: next >= 0,
    items: turn,
    reply: reply?.type === 'assistant' ? reply.text : null,
    error: errors[0]?.text ?? null,
    limit: limits.length === errors.length ? limits : [],
    kind
  }
}
