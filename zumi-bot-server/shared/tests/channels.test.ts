import { describe, expect, it } from 'vitest'
import {
  PAIR_ALPHABET,
  channelMessageId,
  pairCodeIn,
  pairCodeOf,
  parseChannelCommand,
  showPairCode,
  tokenShapeOk
} from '@zumibot/shared/channels'

describe('parseChannelCommand', () => {
  it('reads the fixed commands, an @bot suffix and an argument', () => {
    expect(parseChannelCommand('/new')).toEqual({ kind: 'new', agent: null })
    expect(parseChannelCommand('/new@my_bot  Code Reviewer ')).toEqual({ kind: 'new', agent: 'Code Reviewer' })
    expect(parseChannelCommand('/start')).toEqual({ kind: 'help' })
    expect(parseChannelCommand('/STOP')).toEqual({ kind: 'stop' })
    for (const k of ['agents', 'chats', 'pause', 'resume', 'where', 'help'] as const)
      expect(parseChannelCommand(`/${k}`)).toEqual({ kind: k })
  })

  it('never passes other slash text on: agent commands, /todo, /btw and /compact are unknown here', () => {
    for (const t of ['/compact', '/todo fix it', '/btw what?', '/review-pr 12']) expect(parseChannelCommand(t)?.kind).toBe('unknown')
    expect(parseChannelCommand('/ odd')).toEqual({ kind: 'unknown', name: '' })
  })

  it('leaves plain text alone', () => {
    expect(parseChannelCommand('hello /new')).toBeNull()
  })
})

describe('pairing codes', () => {
  it('makes 8 letters from the alphabet and reads them back loosely', () => {
    const code = pairCodeOf(new Uint8Array([0, 1, 2, 3, 30, 31, 62, 255]))
    expect(code).toHaveLength(8)
    expect([...code].every((c) => PAIR_ALPHABET.includes(c))).toBe(true)
    expect(pairCodeIn(showPairCode(code).toLowerCase())).toBe(code)
    expect(pairCodeIn(` ${code.slice(0, 4)} ${code.slice(4)} `)).toBe(code)
  })

  it('refuses anything that is not a whole code', () => {
    expect(pairCodeIn('ABCD-EFG')).toBeNull()
    expect(pairCodeIn('ABCD-EFG0')).toBeNull() // 0 is not in the alphabet
    expect(pairCodeIn('my code is ABCDEFGH')).toBeNull()
  })
})

describe('tokens and message ids', () => {
  it('checks a Telegram token shape before any request', () => {
    expect(tokenShapeOk('telegram', '123456789:' + 'A'.repeat(35))).toBe(true)
    expect(tokenShapeOk('telegram', 'hello')).toBe(false)
    expect(tokenShapeOk('telegram', '12345:abc def')).toBe(false)
  })

  it('gives an update the same message id every time, within MESSAGE_ID_RE', () => {
    const id = channelMessageId('telegram', '123456', '987654321')
    expect(id).toBe('ch-tg-123456-987654321')
    expect(id).toMatch(/^[A-Za-z0-9-]{1,64}$/)
    expect(channelMessageId('telegram', '1'.repeat(40), '2'.repeat(40))).toHaveLength(64)
  })
})

describe('Slack', () => {
  it('reads ! commands on Slack only, and / on both', () => {
    expect(parseChannelCommand('!new tester', 'slack')).toEqual({ kind: 'new', agent: 'tester' })
    expect(parseChannelCommand('/where', 'slack')).toEqual({ kind: 'where' })
    expect(parseChannelCommand('!new tester', 'telegram')).toBeNull()
    expect(parseChannelCommand('!compact', 'slack')?.kind).toBe('unknown')
  })

  it('needs both Slack tokens in their shapes, and no app token for Telegram', () => {
    expect(tokenShapeOk('slack', 'xoxb-123-456-abcdef', 'xapp-1-A1-123-abc')).toBe(true)
    expect(tokenShapeOk('slack', 'xoxb-123-456-abcdef')).toBe(false)
    expect(tokenShapeOk('slack', 'xapp-1-A1-123-abc', 'xoxb-123-456-abcdef')).toBe(false)
    expect(tokenShapeOk('telegram', '123456789:' + 'A'.repeat(35), 'xapp-1-A1-123-abc')).toBe(false)
    expect(channelMessageId('slack', 'U0BOT', 'Ev06ABC')).toBe('ch-sl-U0BOT-Ev06ABC')
  })
})
