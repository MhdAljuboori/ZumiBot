// Which async operation of a voice request is the current one. Pure: the hook (useVoiceTalk) keeps a token per kind,
// so a result from a cancelled or superseded operation is dropped instead of reaching the machine. The machine's `run`
// only changes on start and stop; this covers a second listen that began while the first was still winding down.
import type { ChatItem, WirePush } from '@zumibot/shared/types'
import { rejectedSendState } from './sendFailure'
import { NO_SPEECH_NOTICE, type TalkPhase } from './voiceTalk'

export type OpKind = 'listen' | 'transcribe'
export const OP_KINDS: readonly OpKind[] = ['listen', 'transcribe']

export function createTokens() {
  const current: Record<OpKind, number> = { listen: 0, transcribe: 0 }
  const alive: Record<OpKind, boolean> = { listen: false, transcribe: false }
  // Never reused, so a late result of a cancelled op cannot match a newer one.
  let seq = 0
  return {
    /** Starts an op of this kind: an earlier one is no longer current (the caller releases its resources first). */
    begin(k: OpKind): number {
      current[k] = ++seq
      alive[k] = true
      return current[k]
    },
    isCurrent: (k: OpKind, n: number): boolean => alive[k] && current[k] === n,
    /** A result arrived: true once for the current op, false for a stale or repeated one. */
    end(k: OpKind, n: number): boolean {
      if (!alive[k] || current[k] !== n) return false
      alive[k] = false
      return true
    },
    /** True when one was live. */
    cancel(k: OpKind): boolean {
      const was = alive[k]
      alive[k] = false
      current[k] = ++seq
      return was
    },
    cancelAll(): void {
      for (const k of OP_KINDS) {
        alive[k] = false
        current[k] = ++seq
      }
    },
    live: (): Record<OpKind, boolean> => ({ ...alive })
  }
}

/** A message id the server accepts (1-64 letters, digits or dashes). randomUUID needs a secure context; a LAN page may have none. */
export function sendId(c: { randomUUID?: () => string } | undefined): string {
  if (typeof c?.randomUUID === 'function') return c.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

/**
 * What a rejected `chats:send` means to the machine. chats:send settles only when the turn ends, so a rejection is no
 * failure once the message is in the chat (stored: the reply or its error item arrives on its own, even after a
 * reconnect); only a message that never got there is `failed`.
 */
export const sendRejection = (items: readonly ChatItem[], id: string): 'sent' | 'failed' =>
  rejectedSendState(items, id) === 'stored' ? 'sent' : 'failed'

/**
 * What a rejected `chats:send` means for the request. A dropped connection (`notConnected`) says nothing about the
 * message, which may be stored: the chat is opened and resyncs after the reconnect to show the truth. A server error
 * is a failure unless the chat (`items`, null when it could not be read) already holds the message.
 */
export const sendOutcome = (notConnected: boolean, items: readonly ChatItem[] | null, id: string): 'open' | 'failed' =>
  notConnected || (items !== null && sendRejection(items, id) === 'sent') ? 'open' : 'failed'

/** How long the island's popup keeps a notice up after a talk that went nowhere. */
export const ISLAND_NOTICE_MS = 8000

/**
 * What the island does when a talk ends without opening a chat: close at once for a plain no-speech (or no notice), else
 * hold the popup so the notice can be read (the host closes it after ISLAND_NOTICE_MS, or the user does).
 */
export const talkEndAction = (notice: string | null): 'close' | 'hold' =>
  notice === null || notice === NO_SPEECH_NOTICE ? 'close' : 'hold'

/** Whether a push is the chat's items with the message sent under `id` in them: the message is stored, so the chat can be opened. */
export const messageInPush = (p: WirePush, chatId: string, id: string): boolean =>
  p.kind === 'items' && p.chatId === chatId && p.items.some((i) => i.type === 'user' && i.id === id)

const STATUS: Record<TalkPhase, string> = {
  idle: 'Tap to talk',
  listening: 'Speak now',
  transcribing: 'Thinking…',
  sending: 'Thinking…',
  ended: 'Tap to talk again'
}
/** The one line under the avatar: what the user should do, or what it is waiting for. */
export const talkStatus = (phase: TalkPhase): string => STATUS[phase]

/** A talk that is running must end when voice talk stops being available (switched off in another tab, the mic refused) or its settings vanish: nothing else would let go of the mic. */
export const shouldStopTalk = (phase: TalkPhase, available: boolean, settingsKnown: boolean): boolean =>
  phase !== 'idle' && phase !== 'ended' && (!available || !settingsKnown)

/** A hidden page (a locked phone, another tab) cannot be spoken to or heard: its talk ends, as dictation stops. The island's window may read as hidden and keeps going. */
export const shouldStopOnHide = (visibility: DocumentVisibilityState, island: boolean): boolean => visibility === 'hidden' && !island
