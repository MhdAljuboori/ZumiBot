import { WebSocket } from 'ws'
import type { ChannelState } from '@zumibot/shared/channels'
import type { Button, ButtonPress, ChannelAdapter, ChannelSink, ChannelUser, InboundFile, InboundMessage, OutText } from './adapter'
import { Outbox } from './outbox'
import { SlackError, isAuthError, type SlackApi } from './slackApi'

// Slack over Socket Mode only: an outbound WebSocket the app-level token opens, no request URL, no public route.
//
// Conversations: a direct message with the bot is its DM channel id (`D…`), and works like Telegram's private chat (a
// current chat, and a reply in a bot message's thread routes to that message's chat). In a channel, each thread is one
// conversation, `<channel>/<thread ts>`: the bot reads it only when the paired user mentions it there, or writes in a thread
// that already is a chat (ChannelService decides; this adapter drops nothing but bots and edits, and reads no history).

export const SLACK_TEXT_MAX = 3000 // a section block's mrkdwn limit; a plain message is kept to the same
const DOWNLOAD_MAX = 25 * 1024 * 1024 // ZumiBot's own attachment limit
const UPLOAD_MAX = 50 * 1024 * 1024
const TEXTS_KEPT = 2000

interface SlackFile {
  id?: string
  name?: string
  mimetype?: string
  size?: number
  url_private_download?: string
  subtype?: string
}
interface SlackEvent {
  type?: string
  subtype?: string
  channel?: string
  channel_type?: string
  user?: string
  bot_id?: string
  text?: string
  ts?: string
  thread_ts?: string
  files?: SlackFile[]
}
interface Envelope {
  envelope_id?: string
  type?: string
  payload?: Record<string, unknown>
  reason?: string
}

export interface SlackAdapterDeps {
  api: SlackApi
  /** Opens the Socket Mode WebSocket (the real `ws` client; a test may pass its own). */
  open?: (url: string) => WebSocket
  sleep: (ms: number) => Promise<void>
  now: () => number
  log: (line: string) => void
}

const splitConv = (conv: string): { channel: string; thread: string | null } => {
  const i = conv.indexOf('/')
  return i < 0 ? { channel: conv, thread: null } : { channel: conv.slice(0, i), thread: conv.slice(i + 1) }
}

const fileOf = (f: SlackFile): InboundFile | null =>
  typeof f.url_private_download === 'string'
    ? {
        ref: f.url_private_download,
        name: (f.name ?? 'file').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 200) || 'file',
        mime: f.mimetype ?? 'application/octet-stream',
        size: typeof f.size === 'number' ? f.size : null
      }
    : null

/** An event as the sink reads it; null for anything it never reads (bots, edits, joins, its own messages). */
export function slackMessageOf(event: SlackEvent, eventId: string, team: string, botUser: string | null): InboundMessage | null {
  if (event.type !== 'message' || !event.channel || !event.user || !event.ts) return null
  if (event.bot_id || event.user === botUser) return null
  if (event.subtype !== undefined && event.subtype !== 'file_share' && event.subtype !== 'thread_broadcast') return null
  const direct = event.channel_type === 'im'
  const raw = event.text ?? ''
  const mention = botUser ? `<@${botUser}>` : null
  const mentioned = !direct && mention !== null && raw.includes(mention)
  // The bot's own mention is not part of what the user said to the agent.
  const text = (mention ? raw.split(mention).join('') : raw)
    .replace(/^\s+/, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
  const files: InboundFile[] = []
  let voice: InboundFile | null = null
  for (const f of event.files ?? []) {
    const file = fileOf(f)
    if (!file) continue
    // An audio clip with no text is a voice note; any other file is an attachment.
    if (voice === null && (f.subtype === 'slack_audio' || file.mime.startsWith('audio/')) && text.trim() === '') voice = file
    else files.push(file)
  }
  const inThread = event.thread_ts !== undefined && event.thread_ts !== event.ts
  return {
    updateId: eventId,
    conv: direct ? event.channel : `${event.channel}/${event.thread_ts ?? event.ts}`,
    from: { id: `${team}:${event.user}`, name: event.user },
    direct,
    mentioned,
    text,
    replyTo: direct && inThread ? event.thread_ts! : null,
    files,
    voice
  }
}

/** A button press (block_actions) as the sink reads it, or null. */
export function slackPressOf(payload: Record<string, unknown>, envelopeId: string): ButtonPress | null {
  if (payload.type !== 'block_actions') return null
  const user = payload.user as { id?: string; team_id?: string } | undefined
  const team = (payload.team as { id?: string } | undefined)?.id ?? user?.team_id
  const channel = (payload.channel as { id?: string } | undefined)?.id
  const message = payload.message as { ts?: string; thread_ts?: string } | undefined
  const action = (payload.actions as { value?: string }[] | undefined)?.[0]
  if (!user?.id || !team || !channel || !message?.ts || typeof action?.value !== 'string') return null
  const direct = channel.startsWith('D')
  return {
    pressId: envelopeId,
    conv: direct ? channel : `${channel}/${message.thread_ts ?? message.ts}`,
    from: { id: `${team}:${user.id}`, name: user.id },
    direct,
    msg: message.ts,
    token: action.value
  }
}

/** Buttons as Block Kit: the text in a section, one actions block per row; each button's value is its opaque token. */
export function blocksOf(text: string, buttons: Button[][] | null): unknown[] {
  const blocks: unknown[] = [{ type: 'section', text: { type: 'mrkdwn', text: text.slice(0, SLACK_TEXT_MAX) || ' ' } }]
  ;(buttons ?? []).forEach((row, i) => {
    if (row.length === 0) return
    blocks.push({
      type: 'actions',
      block_id: `r${i}`,
      elements: row.map((b, j) => ({
        type: 'button',
        action_id: `b${i}_${j}`,
        text: { type: 'plain_text', text: b.label.slice(0, 75), emoji: true },
        value: b.token
      }))
    })
  })
  return blocks
}

export class SlackAdapter implements ChannelAdapter {
  readonly platform = 'slack' as const
  readonly sharedConvs = true
  readonly limits = { text: SLACK_TEXT_MAX, uploadBytes: UPLOAD_MAX, downloadBytes: DOWNLOAD_MAX }
  private botUser: string | null = null
  private team: string | null = null
  private ws: WebSocket | null = null
  private stopped = false
  private loop: Promise<void> | null = null
  private readonly outbox: Outbox
  // Each message's text, so its buttons can be changed without sending the text again (chat.update needs both).
  private texts = new Map<string, string>()
  private names = new Map<string, string>()

  constructor(private readonly d: SlackAdapterDeps) {
    this.outbox = new Outbox({
      gapMs: 1000,
      now: d.now,
      sleep: d.sleep,
      retryOf: (e) =>
        e instanceof SlackError ? { code: e.status === 429 ? 429 : e.status === 0 ? 0 : 400, retryAfter: e.retryAfter } : null
    })
  }

  isShared(conv: string): boolean {
    return conv.includes('/')
  }

  botId(): string | null {
    return this.botUser
  }

  start(sink: ChannelSink): void {
    if (this.loop) return
    this.stopped = false
    this.loop = this.run(sink).catch((err) => this.d.log(`slack socket stopped: ${err instanceof SlackError ? err.error : 'error'}`))
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.outbox.close()
    try {
      this.ws?.close()
    } catch {
      /* already closed */
    }
    const loop = this.loop
    this.loop = null
    await loop
  }

  private async run(sink: ChannelSink): Promise<void> {
    let backoff = 0
    const set = (s: ChannelState, bot: string | null = null) => sink.state(s, bot)
    let botName: string | null = null
    while (!this.stopped) {
      try {
        set('connecting')
        if (this.botUser === null) {
          const me = await this.d.api.call<{ user_id: string; team_id: string; user?: string }>('auth.test')
          this.botUser = me.user_id
          this.team = me.team_id
          botName = me.user ?? null
        }
        const { url } = await this.d.api.call<{ url: string }>('apps.connections.open', {}, { token: 'app' })
        if (!this.d.api.socketUrlOk(url)) throw new SlackError('apps.connections.open', 400, 'bad_socket_url', null)
        await this.session(url, sink, () => {
          backoff = 0
          set('connected', botName)
        })
        if (this.stopped) return
      } catch (err) {
        if (this.stopped) return
        if (isAuthError(err)) {
          set('badToken')
          this.d.log('slack refused a token')
          return
        }
        set('error')
        const e = err instanceof SlackError ? err : null
        backoff = Math.min(60_000, Math.max(2000, backoff * 2))
        const wait = e?.status === 429 && e.retryAfter ? e.retryAfter * 1000 : backoff
        this.d.log(`slack connection failed (${e?.error ?? 'error'}), retrying in ${Math.round(wait / 1000)} s`)
        await this.d.sleep(wait)
        continue
      }
      // A clean disconnect (Slack refreshes sockets now and then): reconnect at once.
    }
  }

  /** One socket: envelopes are handled one at a time and acked only once handled, so a failure means Slack sends it again. */
  private session(url: string, sink: ChannelSink, connected: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = this.d.open ? this.d.open(url) : new WebSocket(url)
      this.ws = ws
      let chain: Promise<void> = Promise.resolve()
      let opened = false
      ws.on('message', (data) => {
        let env: Envelope
        try {
          env = JSON.parse(String(data)) as Envelope
        } catch {
          return
        }
        if (env.type === 'hello') {
          opened = true
          connected()
          return
        }
        if (env.type === 'disconnect') {
          ws.close()
          return
        }
        const id = env.envelope_id
        if (!id) return
        chain = chain.then(async () => {
          try {
            await this.handle(env, sink)
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ envelope_id: id }))
          } catch (err) {
            // Not acked: Slack delivers it again, and the message id drops it if it was already stored.
            this.d.log(`slack event not handled: ${err instanceof Error ? err.message.slice(0, 120) : 'error'}`)
          }
        })
      })
      ws.on('close', () => {
        if (this.ws === ws) this.ws = null
        void chain.then(() => (opened || this.stopped ? resolve() : reject(new SlackError('socket', 0, 'closed_before_hello', null))))
      })
      ws.on('error', () => {
        try {
          ws.close()
        } catch {
          /* closing */
        }
      })
    })
  }

  private async handle(env: Envelope, sink: ChannelSink): Promise<void> {
    const payload = env.payload ?? {}
    if (env.type === 'events_api') {
      const team = typeof payload.team_id === 'string' ? payload.team_id : (this.team ?? '')
      const eventId = typeof payload.event_id === 'string' ? payload.event_id : (env.envelope_id ?? '')
      const m = slackMessageOf((payload.event ?? {}) as SlackEvent, eventId, team, this.botUser)
      if (m) await sink.message(m)
      return
    }
    if (env.type === 'interactive') {
      const p = slackPressOf(payload, env.envelope_id ?? '')
      if (p) await sink.press(p)
    }
  }

  async userName(u: ChannelUser): Promise<string> {
    const user = u.id.split(':')[1] ?? u.id
    const known = this.names.get(user)
    if (known) return known
    try {
      const r = await this.d.api.call<{
        user?: { real_name?: string; name?: string; profile?: { display_name?: string; real_name?: string } }
      }>('users.info', { user }, { form: true })
      const name = r.user?.profile?.display_name || r.user?.profile?.real_name || r.user?.real_name || r.user?.name || user
      this.names.set(user, name)
      return name
    } catch {
      return user
    }
  }

  private keep(ts: string, text: string): void {
    this.texts.set(ts, text)
    if (this.texts.size > TEXTS_KEPT) this.texts.delete(this.texts.keys().next().value as string)
  }

  async send(conv: string, text: OutText, o: { buttons?: Button[][]; replyTo?: string | null } = {}): Promise<string> {
    const { channel, thread } = splitConv(conv)
    const body = {
      channel,
      text: text.html.slice(0, SLACK_TEXT_MAX),
      unfurl_links: false,
      unfurl_media: false,
      ...(thread ? { thread_ts: thread } : {}),
      ...(o.buttons && o.buttons.length > 0 ? { blocks: blocksOf(text.html, o.buttons) } : {})
    }
    const r = await this.outbox.send(channel, () => this.d.api.call<{ ts: string }>('chat.postMessage', body), { final: true })
    const ts = r?.ts ?? ''
    if (ts) this.keep(ts, text.html)
    return ts
  }

  // No live preview: Slack's streaming methods are still to verify, and editing a placeholder would spend the workspace's
  // chat.update budget on every reply. The final messages carry the text.
  async draft(): Promise<boolean> {
    return false
  }

  async typing(): Promise<void> {}

  async clearButtons(conv: string, msg: string): Promise<void> {
    const text = this.texts.get(msg)
    if (text === undefined) return
    await this.update(conv, msg, text, null)
  }

  async setButtons(conv: string, msg: string, buttons: Button[][]): Promise<void> {
    const text = this.texts.get(msg)
    if (text === undefined) return
    await this.update(conv, msg, text, buttons)
  }

  async edit(conv: string, msg: string, text: OutText, buttons: Button[][] | null): Promise<void> {
    this.keep(msg, text.html)
    await this.update(conv, msg, text.html, buttons)
  }

  private async update(conv: string, msg: string, text: string, buttons: Button[][] | null): Promise<void> {
    const { channel } = splitConv(conv)
    await this.outbox.send(
      channel,
      () =>
        this.d.api
          .call('chat.update', { channel, ts: msg, text: text.slice(0, SLACK_TEXT_MAX), blocks: blocksOf(text, buttons) })
          .catch((err) => {
            // A message the user deleted, or one that can no longer be edited: nothing to change.
            if (
              err instanceof SlackError &&
              (err.error === 'message_not_found' || err.error === 'cant_update_message' || err.error === 'edit_window_closed')
            )
              return
            throw err
          }),
      { final: true }
    )
  }

  /** No ForceReply on Slack: the prompt says where to answer (its own thread in a DM, the thread itself in a channel). */
  ask(conv: string, text: OutText): Promise<string> {
    return this.send(conv, text)
  }

  async ackPress(p: ButtonPress, notice?: string): Promise<void> {
    // The envelope itself is acked by the socket loop; a notice is a message only the presser sees.
    if (!notice) return
    const { channel, thread } = splitConv(p.conv)
    const user = p.from.id.split(':')[1] ?? p.from.id
    await this.d.api
      .call('chat.postEphemeral', { channel, user, text: notice, ...(thread ? { thread_ts: thread } : {}) })
      .catch(() => undefined)
  }

  async sendFile(conv: string, name: string, bytes: Uint8Array, caption?: string): Promise<string> {
    const { channel, thread } = splitConv(conv)
    await this.outbox.send(
      channel,
      async () => {
        const up = await this.d.api.call<{ upload_url: string; file_id: string }>(
          'files.getUploadURLExternal',
          { filename: name, length: bytes.length },
          { form: true }
        )
        await this.d.api.upload(up.upload_url, bytes, name)
        await this.d.api.call('files.completeUploadExternal', {
          files: [{ id: up.file_id, title: name }],
          channel_id: channel,
          ...(thread ? { thread_ts: thread } : {}),
          ...(caption ? { initial_comment: caption.slice(0, 1000) } : {})
        })
      },
      { final: true }
    )
    // completeUploadExternal names no message ts: a reply to the file can't route by it.
    return ''
  }

  fetchFile(f: InboundFile): Promise<Uint8Array> {
    if (f.size !== null && f.size > DOWNLOAD_MAX) return Promise.reject(new SlackError('download', 413, 'too_big', null))
    return this.d.api.download(f.ref, DOWNLOAD_MAX)
  }
}
