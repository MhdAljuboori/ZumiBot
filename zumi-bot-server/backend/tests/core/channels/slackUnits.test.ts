import { describe, expect, it } from 'vitest'
import { blocksOf, slackMessageOf, slackPressOf } from '../../../src/core/channels/slackAdapter'
import { SlackError, createSlackApi } from '../../../src/core/channels/slackApi'

const BOT = 'U0BOT'

describe('slackMessageOf', () => {
  it('reads a DM, its thread reply target, files and a voice clip', () => {
    const m = slackMessageOf(
      {
        type: 'message',
        channel: 'D1',
        channel_type: 'im',
        user: 'U1',
        text: 'hi &amp; &lt;b&gt;',
        ts: '2.0',
        thread_ts: '1.0',
        files: [{ name: '../x.txt', mimetype: 'text/plain', size: 3, url_private_download: 'https://files.slack.com/a' }]
      },
      'Ev1',
      'T1',
      BOT
    )!
    expect(m).toMatchObject({
      updateId: 'Ev1',
      conv: 'D1',
      direct: true,
      mentioned: false,
      text: 'hi & <b>',
      replyTo: '1.0',
      from: { id: 'T1:U1' }
    })
    expect(m.files[0].name).toBe('.._x.txt')
    const v = slackMessageOf(
      {
        type: 'message',
        subtype: 'file_share',
        channel: 'D1',
        channel_type: 'im',
        user: 'U1',
        text: '',
        ts: '3.0',
        files: [{ subtype: 'slack_audio', mimetype: 'audio/webm', url_private_download: 'https://files.slack.com/v' }]
      },
      'Ev2',
      'T1',
      BOT
    )!
    expect(v.voice?.mime).toBe('audio/webm')
    expect(v.files).toEqual([])
  })

  it('makes each channel thread its own conversation and strips the mention', () => {
    const top = slackMessageOf(
      { type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: `<@${BOT}> !new a`, ts: '5.0' },
      'Ev3',
      'T1',
      BOT
    )!
    expect(top).toMatchObject({ conv: 'C1/5.0', direct: false, mentioned: true, text: '!new a', replyTo: null })
    const inThread = slackMessageOf(
      { type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: 'more', ts: '6.0', thread_ts: '5.0' },
      'Ev4',
      'T1',
      BOT
    )!
    expect(inThread).toMatchObject({ conv: 'C1/5.0', mentioned: false, replyTo: null })
  })

  it('drops bots, its own messages, edits and joins', () => {
    const base = { type: 'message', channel: 'C1', channel_type: 'channel', text: 'x', ts: '1.0' }
    expect(slackMessageOf({ ...base, user: 'U2', bot_id: 'B1' }, 'e', 'T1', BOT)).toBeNull()
    expect(slackMessageOf({ ...base, user: BOT }, 'e', 'T1', BOT)).toBeNull()
    expect(slackMessageOf({ ...base, user: 'U2', subtype: 'message_changed' }, 'e', 'T1', BOT)).toBeNull()
    expect(slackMessageOf({ ...base, user: 'U2', subtype: 'channel_join' }, 'e', 'T1', BOT)).toBeNull()
  })
})

describe('slackPressOf and blocks', () => {
  it('reads a press in a DM and in a channel thread', () => {
    const dm = slackPressOf(
      {
        type: 'block_actions',
        user: { id: 'U1', team_id: 'T1' },
        channel: { id: 'D1' },
        message: { ts: '9.0' },
        actions: [{ value: 'tok' }]
      },
      'env'
    )!
    expect(dm).toMatchObject({ conv: 'D1', direct: true, msg: '9.0', token: 'tok', from: { id: 'T1:U1' } })
    const ch = slackPressOf(
      {
        type: 'block_actions',
        user: { id: 'U2', team_id: 'T1' },
        channel: { id: 'C1' },
        message: { ts: '9.0', thread_ts: '5.0' },
        actions: [{ value: 'tok' }]
      },
      'env'
    )!
    expect(ch).toMatchObject({ conv: 'C1/5.0', direct: false })
    expect(slackPressOf({ type: 'view_submission' }, 'env')).toBeNull()
  })

  it('carries only the opaque token as each button value', () => {
    const b = blocksOf('text', [
      [
        { label: 'Allow once', token: 'abc' },
        { label: 'x'.repeat(100), token: 'def' }
      ]
    ]) as { type: string; elements?: { value: string; text: { text: string } }[] }[]
    expect(b[0]).toEqual({ type: 'section', text: { type: 'mrkdwn', text: 'text' } })
    expect(b[1].elements!.map((e) => e.value)).toEqual(['abc', 'def'])
    expect(b[1].elements![1].text.text).toHaveLength(75)
  })
})

describe('Slack API client', () => {
  const BOT_T = 'xoxb-111-222-SECRETBOT'
  const APP_T = 'xapp-1-A1-333-SECRETAPP'

  it('sends the token only in the header and never in an error', async () => {
    let seen: Headers | null = null
    const api = createSlackApi({
      botToken: BOT_T,
      appToken: APP_T,
      fetch: async (_u, init) => {
        seen = new Headers(init?.headers)
        return new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }))
      }
    })
    const err = (await api.call('auth.test').catch((e: unknown) => e)) as SlackError
    expect(seen!.get('authorization')).toBe(`Bearer ${BOT_T}`)
    expect(err.error).toBe('invalid_auth')
    expect(JSON.stringify({ m: err.message, s: err.stack })).not.toMatch(/SECRET/)
    const net = (await createSlackApi({
      botToken: BOT_T,
      appToken: APP_T,
      fetch: async () => {
        throw new Error(`fail ${BOT_T}`)
      }
    })
      .call('x')
      .catch((e: unknown) => e)) as SlackError
    expect(JSON.stringify({ m: net.message, s: net.stack, e: net.error })).not.toMatch(/SECRET/)
  })

  it('reads a 429 Retry-After and uses the app token only for the socket', async () => {
    const api = createSlackApi({
      botToken: BOT_T,
      appToken: APP_T,
      fetch: async (_u, init) => new Response('{}', { status: 429, headers: { 'retry-after': '7' } })
    })
    const e = (await api.call('chat.postMessage').catch((x: unknown) => x)) as SlackError
    expect([e.status, e.retryAfter]).toEqual([429, 7])
    let auth = ''
    await createSlackApi({
      botToken: BOT_T,
      appToken: APP_T,
      fetch: async (_u, init) => {
        auth = new Headers(init?.headers).get('authorization') ?? ''
        return new Response(JSON.stringify({ ok: true, url: 'wss://wss-primary.slack.com/link' }))
      }
    }).call('apps.connections.open', {}, { token: 'app' })
    expect(auth).toBe(`Bearer ${APP_T}`)
  })

  it("opens only Slack sockets and Slack file URLs (or the dev hook's own origin)", () => {
    const real = createSlackApi({ botToken: BOT_T, appToken: APP_T })
    expect(real.socketUrlOk('wss://wss-primary.slack.com/link/?ticket=1')).toBe(true)
    expect(real.socketUrlOk('ws://wss-primary.slack.com/link')).toBe(false)
    expect(real.socketUrlOk('wss://evil.example/slack.com')).toBe(false)
    expect(real.socketUrlOk('wss://slack.com.evil.example/')).toBe(false)
    const test = createSlackApi({ botToken: BOT_T, appToken: APP_T, origin: 'http://127.0.0.1:4555' })
    expect(test.socketUrlOk('ws://127.0.0.1:4555/socket')).toBe(true)
    expect(test.socketUrlOk('ws://127.0.0.1:9999/socket')).toBe(false)
  })

  it('refuses a download from anywhere but Slack', async () => {
    const api = createSlackApi({ botToken: BOT_T, appToken: APP_T, fetch: async () => new Response('x') })
    await expect(api.download('https://evil.example/f', 10)).rejects.toThrow('bad_file_url')
    await expect(api.upload('https://evil.example/u', new Uint8Array(1), 'a')).rejects.toThrow('bad_upload_url')
  })
})
