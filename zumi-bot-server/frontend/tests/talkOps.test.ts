import { describe, expect, it } from 'vitest'
import type { ChatItem, WirePush } from '@zumibot/shared/types'
import { NO_SPEECH_NOTICE } from '../src/state/voiceTalk'
import {
  ISLAND_NOTICE_MS,
  OP_KINDS,
  createTokens,
  messageInPush,
  sendId,
  sendOutcome,
  sendRejection,
  talkEndAction,
  shouldStopTalk,
  shouldStopOnHide,
  talkStatus
} from '../src/state/talkOps'

describe('createTokens', () => {
  it('knows only the latest op of a kind as current', () => {
    const t = createTokens()
    const a = t.begin('listen')
    expect(t.isCurrent('listen', a)).toBe(true)
    const b = t.begin('listen')
    expect(t.isCurrent('listen', a)).toBe(false)
    expect(t.isCurrent('listen', b)).toBe(true)
  })

  it('keeps kinds apart', () => {
    const t = createTokens()
    const l = t.begin('listen')
    t.begin('transcribe')
    expect(t.isCurrent('listen', l)).toBe(true)
  })

  it('end settles a current op once, and refuses a stale or repeated one', () => {
    const t = createTokens()
    const a = t.begin('transcribe')
    expect(t.end('transcribe', a)).toBe(true)
    expect(t.end('transcribe', a)).toBe(false)
    expect(t.isCurrent('transcribe', a)).toBe(false)
    const b = t.begin('transcribe')
    t.cancel('transcribe')
    expect(t.end('transcribe', b)).toBe(false)
  })

  it('cancel drops a late result of the op and reports whether one was live', () => {
    const t = createTokens()
    const a = t.begin('transcribe')
    expect(t.live().transcribe).toBe(true)
    expect(t.cancel('transcribe')).toBe(true)
    expect(t.isCurrent('transcribe', a)).toBe(false)
    expect(t.live().transcribe).toBe(false)
    expect(t.cancel('transcribe')).toBe(false)
  })

  it('a token is never reused after a cancel', () => {
    const t = createTokens()
    const a = t.begin('listen')
    t.cancel('listen')
    expect(t.begin('listen')).not.toBe(a)
    expect(t.isCurrent('listen', a)).toBe(false)
  })

  it('cancelAll drops every kind', () => {
    const t = createTokens()
    const toks = OP_KINDS.map((k) => [k, t.begin(k)] as const)
    t.cancelAll()
    for (const [k, n] of toks) expect(t.isCurrent(k, n)).toBe(false)
    expect(t.live()).toEqual({ listen: false, transcribe: false })
  })
})

describe('sendId', () => {
  it('is 1-64 letters, digits or dashes (the server refuses anything else), and not repeated', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const id = sendId(undefined)
      expect(id).toMatch(/^[A-Za-z0-9-]{1,64}$/)
      ids.add(id)
    }
    expect(ids.size).toBe(50)
  })

  it('uses randomUUID when the page has one', () => {
    expect(sendId({ randomUUID: () => '11111111-2222-3333-4444-555555555555' })).toBe('11111111-2222-3333-4444-555555555555')
  })
})

describe('sendRejection', () => {
  const item = (id: string): ChatItem => ({ type: 'user', id, text: 'x', ts: 1 })

  it('a message the chat holds went in: the turn failed or the socket dropped, and the reply or its error item still comes', () => {
    expect(sendRejection([item('m1')], 'm1')).toBe('sent')
  })

  it('a message the chat never got is a failed send', () => {
    expect(sendRejection([item('other')], 'm1')).toBe('failed')
    expect(sendRejection([], 'm1')).toBe('failed')
  })
})

describe('sendOutcome', () => {
  const item = (id: string): ChatItem => ({ type: 'user', id, text: 'x', ts: 1 })

  it('a dropped connection is unknown, not failed: the chat is opened and resyncs to the truth', () => {
    expect(sendOutcome(true, null, 'm1')).toBe('open')
    expect(sendOutcome(true, [], 'm1')).toBe('open')
  })
  it('a server error with the message in the chat opens it', () => {
    expect(sendOutcome(false, [item('m1')], 'm1')).toBe('open')
  })
  it('a server error with the message absent, or the chat unreadable, is a failed send', () => {
    expect(sendOutcome(false, [item('other')], 'm1')).toBe('failed')
    expect(sendOutcome(false, [], 'm1')).toBe('failed')
    expect(sendOutcome(false, null, 'm1')).toBe('failed')
  })
})

describe('talkEndAction', () => {
  it('a talk that ended with no notice, or plain no-speech, lets the island go at once', () => {
    expect(talkEndAction(null)).toBe('close')
    expect(talkEndAction(NO_SPEECH_NOTICE)).toBe('close')
  })
  it('any other notice keeps the island up so it can be read, closing on its own later', () => {
    for (const n of [
      "I don't know an agent called X.",
      "Who should I ask? Say: ask, then an agent's name.",
      "Couldn't understand that.",
      "Couldn't send that: “hi”"
    ])
      expect(talkEndAction(n)).toBe('hold')
    expect(ISLAND_NOTICE_MS).toBe(8000)
  })
})

describe('messageInPush', () => {
  const items = (chatId: string, list: ChatItem[]): WirePush => ({
    chatId,
    kind: 'items',
    seq: 1,
    base: null,
    from: 0,
    items: list,
    clearStreaming: false
  })
  const user = (id: string): ChatItem => ({ type: 'user', id, text: 'x', ts: 1 })

  it("is true when the chat's items push carries the message sent under that id", () => {
    expect(messageInPush(items('c1', [user('m1')]), 'c1', 'm1')).toBe(true)
  })
  it('is false for another chat, another message, or a push that is not items', () => {
    expect(messageInPush(items('c2', [user('m1')]), 'c2x', 'm1')).toBe(false)
    expect(messageInPush(items('c1', [user('m2')]), 'c1', 'm1')).toBe(false)
    expect(messageInPush({ chatId: 'c1', kind: 'running', running: true } as unknown as WirePush, 'c1', 'm1')).toBe(false)
  })
})

describe('talkStatus', () => {
  it('says in a few words what the user should do or is waiting for', () => {
    expect(talkStatus('idle')).toBe('Tap to talk')
    expect(talkStatus('listening')).toBe('Speak now')
    for (const p of ['transcribing', 'sending'] as const) expect(talkStatus(p)).toBe('Thinking…')
    expect(talkStatus('ended')).toBe('Tap to talk again')
  })
})

describe('shouldStopTalk', () => {
  it('stops a talk that is running once voice talk is unavailable (switched off elsewhere, mic refused) or its settings are gone', () => {
    for (const phase of ['listening', 'transcribing', 'sending'] as const) {
      expect(shouldStopTalk(phase, false, true)).toBe(true)
      expect(shouldStopTalk(phase, true, false)).toBe(true)
      expect(shouldStopTalk(phase, true, true)).toBe(false)
    }
  })

  it('has nothing to stop when the talk is idle or ended', () => {
    for (const phase of ['idle', 'ended'] as const) expect(shouldStopTalk(phase, false, false)).toBe(false)
  })
})

describe('shouldStopOnHide', () => {
  it('a hidden page that is not the island ends the talk (its mic is muted)', () => {
    expect(shouldStopOnHide('hidden', false)).toBe(true)
  })

  it('a visible page, or the island whose window the shell may call hidden, keeps talking', () => {
    expect(shouldStopOnHide('visible', false)).toBe(false)
    expect(shouldStopOnHide('hidden', true)).toBe(false)
    expect(shouldStopOnHide('visible', true)).toBe(false)
  })
})
