import { describe, expect, it } from 'vitest'
import { Outbox } from '../../../src/core/channels/outbox'
import { Pairing } from '../../../src/core/channels/pairing'
import { ButtonTokens, BUTTON_TTL_MS } from '../../../src/core/channels/buttons'
import { CHANNEL_HIDDEN, scrubOutbound } from '../../../src/core/channels/channelScrub'
import { TelegramError, createTelegramApi, testChannelOrigin } from '../../../src/core/channels/telegramApi'
import { inboundOf } from '../../../src/core/channels/telegramAdapter'
import { PAIR_TRIES_PER_SENDER, PAIR_TTL_MS } from '@zumibot/shared/channels'

const clock = () => {
  let t = 1_000_000
  const sleeps: number[] = []
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      t += ms
    },
    advance: (ms: number) => (t += ms),
    sleeps
  }
}

describe('Outbox', () => {
  const retryOf = (e: unknown) => (e instanceof TelegramError ? { code: e.code, retryAfter: e.retryAfter } : null)

  it('keeps one call per gap in a conversation, and conversations apart', async () => {
    const c = clock()
    const box = new Outbox({ gapMs: 1000, now: c.now, sleep: c.sleep, retryOf })
    const order: string[] = []
    await Promise.all([
      box.send('a', async () => order.push('a1')),
      box.send('a', async () => order.push('a2')),
      box.send('b', async () => order.push('b1'))
    ])
    expect(order).toEqual(['a1', 'b1', 'a2'])
    expect(c.sleeps).toEqual([1000])
  })

  it('honours retry_after for a final message and never drops it', async () => {
    const c = clock()
    const box = new Outbox({ gapMs: 0, now: c.now, sleep: c.sleep, retryOf })
    let n = 0
    const out = await box.send('a', async () => {
      if (n++ === 0) throw new TelegramError('sendMessage', 429, 7, 'Too Many Requests')
      return 'ok'
    })
    expect(out).toBe('ok')
    expect(c.sleeps).toContain(7000)
  })

  it('rejects a final on an error that is not a rate limit or the network', async () => {
    const c = clock()
    const box = new Outbox({ gapMs: 0, now: c.now, sleep: c.sleep, retryOf })
    await expect(
      box.send('a', async () => {
        throw new TelegramError('sendMessage', 400, null, 'Bad Request')
      })
    ).rejects.toThrow('Telegram sendMessage failed (400)')
  })

  it('coalesces previews: a newer one replaces a queued one, and a failed preview resolves quietly', async () => {
    const c = clock()
    const box = new Outbox({ gapMs: 1000, now: c.now, sleep: c.sleep, retryOf })
    const ran: string[] = []
    const first = box.send('a', async () => ran.push('final'), { final: true })
    const p1 = box.send('a', async () => ran.push('d1'), { key: 'draft' })
    const p2 = box.send('a', async () => ran.push('d2'), { key: 'draft' })
    expect(await p1).toBeUndefined()
    await Promise.all([first, p2])
    expect(ran).toEqual(['final', 'd2'])
    expect(
      await box.send(
        'a',
        async () => {
          throw new TelegramError('x', 400, null, '')
        },
        { key: 'draft' }
      )
    ).toBeUndefined()
  })
})

describe('Pairing', () => {
  const bytes = (n: number) => new Uint8Array(n).fill(7)

  it('works once, for the right code only', () => {
    const c = clock()
    const p = new Pairing({ random: bytes, now: c.now })
    const { code } = p.start()
    expect(p.attempt('x', 'hello')).toBe('none') // not code-shaped: not even a try
    expect(p.attempt('x', 'ABCD-EFGH')).toBe('wrong')
    expect(p.attempt('y', code)).toBe('paired')
    expect(p.attempt('y', code)).toBe('none')
    expect(p.open()).toBeNull()
  })

  it('expires, limits each sender, and is voided by too many wrong tries', () => {
    const c = clock()
    const p = new Pairing({ random: bytes, now: c.now })
    const { code } = p.start()
    for (let i = 0; i < PAIR_TRIES_PER_SENDER; i++) expect(p.attempt('x', 'ABCD-EFGH')).toBe('wrong')
    expect(p.attempt('x', code)).toBe('limited')
    c.advance(PAIR_TTL_MS)
    expect(p.attempt('z', code)).toBe('none')

    const q = new Pairing({ random: bytes, now: c.now })
    const r = q.start()
    for (let i = 0; i < 20; i++) q.attempt(`s${i}`, 'ABCD-EFGH')
    expect(q.attempt('owner', r.code)).toBe('none')
  })
})

describe('ButtonTokens', () => {
  it('maps a token to its action once per group, in its own conversation only, until it expires', () => {
    const c = clock()
    let n = 0
    const b = new ButtonTokens({ random: () => `t${n++}`, now: c.now })
    const a = b.issue('conv', 'g', { kind: 'newChat', agent: 'a' }, true)
    const z = b.issue('conv', 'g', { kind: 'newChat', agent: 'z' }, true)
    expect(b.take('other', a)).toBeNull()
    expect(b.take('conv', a)).toEqual({ kind: 'newChat', agent: 'a' })
    expect(b.take('conv', z)).toBeNull() // burned with its group
    const f = b.issue('conv', 'files', { kind: 'openChat', chatId: 'c' }, false)
    expect(b.take('conv', f)).not.toBeNull()
    expect(b.take('conv', f)).not.toBeNull()
    c.advance(BUTTON_TTL_MS + 1)
    expect(b.take('conv', f)).toBeNull()
    expect(b.take('conv', 'forged')).toBeNull()
  })
})

describe('scrubOutbound', () => {
  it('hides every vault value and card number, however it is spaced', () => {
    const s = { values: ['hunter22', 'sk-abc', 'sk-abcdef'], cards: ['4242424242424242'] }
    expect(scrubOutbound('pw hunter22 key sk-abcdef', s)).toBe(`pw ${CHANNEL_HIDDEN} key ${CHANNEL_HIDDEN}`)
    expect(scrubOutbound('card 4242 4242-4242 4242 ok', s)).toBe(`card ${CHANNEL_HIDDEN} ok`)
    expect(scrubOutbound('order 14242424242424242 stays', s)).toBe('order 14242424242424242 stays')
  })
})

describe('Telegram API client', () => {
  const TOKEN = '42:' + 'S'.repeat(40)

  it('never puts the URL (which holds the token) into an error', async () => {
    const api = createTelegramApi({
      token: TOKEN,
      origin: 'http://127.0.0.1:1',
      fetch: async (u) => {
        throw new Error(`connect failed ${String(u)}`)
      }
    })
    const err = await api.call('getMe').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TelegramError)
    expect(JSON.stringify({ m: (err as Error).message, d: (err as TelegramError).description, s: (err as Error).stack })).not.toContain(
      'SSSS'
    )
  })

  it('reads ok, error_code and retry_after', async () => {
    const reply = (body: unknown) => async () => new Response(JSON.stringify(body))
    expect(await createTelegramApi({ token: TOKEN, fetch: reply({ ok: true, result: 5 }) }).call('x')).toBe(5)
    const e = (await createTelegramApi({
      token: TOKEN,
      fetch: reply({ ok: false, error_code: 429, description: 'slow', parameters: { retry_after: 3 } })
    })
      .call('x')
      .catch((x: unknown) => x)) as TelegramError
    expect([e.code, e.retryAfter]).toEqual([429, 3])
  })

  it('refuses a download past its limit', async () => {
    const api = createTelegramApi({
      token: TOKEN,
      fetch: async () => new Response(new Uint8Array(100), { headers: { 'content-length': '100' } })
    })
    await expect(api.download('a/b.ogg', 10)).rejects.toThrow('(413)')
    await expect(api.download('../x', 10)).rejects.toThrow('(400)')
  })

  it('accepts only an http://127.0.0.1:<port> origin as the dev hook', () => {
    expect(testChannelOrigin('http://127.0.0.1:8123')).toBe('http://127.0.0.1:8123')
    for (const bad of [
      'https://127.0.0.1:8123',
      'http://localhost:8123',
      'http://127.0.0.1',
      'http://127.0.0.1:8123/x',
      'http://u:p@127.0.0.1:1',
      'nope',
      undefined
    ])
      expect(testChannelOrigin(bad)).toBeNull()
  })
})

describe('inboundOf', () => {
  it('reads a private message, its reply, files and voice; drops bots', () => {
    const u = {
      update_id: 9,
      message: {
        message_id: 3,
        from: { id: 7, first_name: 'A' },
        chat: { id: 7, type: 'private' },
        caption: 'see',
        reply_to_message: { message_id: 2 },
        document: { file_id: 'f', file_name: '../evil/name.txt', file_size: 4 },
        voice: { file_id: 'v' }
      }
    }
    const r = inboundOf(u) as {
      message: { direct: boolean; text: string; replyTo: string; files: { name: string }[]; voice: { ref: string } }
    }
    expect(r.message.direct).toBe(true)
    expect(r.message.text).toBe('see')
    expect(r.message.replyTo).toBe('2')
    expect(r.message.files[0].name).toBe(`.._evil_name.txt`)
    expect(r.message.voice.ref).toBe('v')
    expect(
      inboundOf({ update_id: 1, message: { message_id: 1, from: { id: 1, is_bot: true }, chat: { id: 1, type: 'private' }, text: 'x' } })
    ).toBeNull()
    const g = inboundOf({ update_id: 2, message: { message_id: 1, from: { id: 1 }, chat: { id: -5, type: 'group' }, text: 'x' } }) as {
      message: { direct: boolean }
    }
    expect(g.message.direct).toBe(false)
  })
})
