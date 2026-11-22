import { CHANNEL_COMMANDS, type ChannelState } from '@zumibot/shared/channels'
import type { Button, ButtonPress, ChannelAdapter, ChannelSink, InboundFile, InboundMessage, OutText } from './adapter'
import { Outbox } from './outbox'
import { TelegramError, type TelegramApi } from './telegramApi'

// Telegram over long polling only: outbound HTTPS, no webhook, no public route.

const POLL_TIMEOUT_S = 25
export const TELEGRAM_TEXT_MAX = 4096
const DOWNLOAD_MAX = 20 * 1024 * 1024 // getFile's own limit
const UPLOAD_MAX = 50 * 1024 * 1024
const HANDLE_TRIES = 3

interface TgUser {
  id: number
  is_bot?: boolean
  first_name?: string
  last_name?: string
  username?: string
}
interface TgChat {
  id: number
  type: string
}
interface TgFileish {
  file_id: string
  file_size?: number
  mime_type?: string
  file_name?: string
}
interface TgMessage {
  message_id: number
  from?: TgUser
  chat: TgChat
  text?: string
  caption?: string
  reply_to_message?: { message_id: number }
  document?: TgFileish
  photo?: (TgFileish & { width: number; height: number })[]
  voice?: TgFileish & { duration?: number }
  audio?: TgFileish
}
interface TgCallback {
  id: string
  from: TgUser
  message?: { message_id: number; chat: TgChat }
  data?: string
}
interface TgUpdate {
  update_id: number
  message?: TgMessage
  callback_query?: TgCallback
}

export interface TelegramAdapterDeps {
  api: TelegramApi
  sleep: (ms: number) => Promise<void>
  now: () => number
  log: (line: string) => void
}

const nameOf = (u: TgUser): string =>
  [u.first_name, u.last_name].filter(Boolean).join(' ') || (u.username ? `@${u.username}` : String(u.id))

const fileOf = (f: TgFileish, fallbackName: string, mime: string): InboundFile => ({
  ref: f.file_id,
  name: (f.file_name ?? fallbackName).replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 200) || fallbackName,
  mime: f.mime_type ?? mime,
  size: typeof f.file_size === 'number' ? f.file_size : null
})

/** An update as the sink reads it; null for anything it never reads (edits, channel posts, a bot's own messages). */
export function inboundOf(u: TgUpdate): { message: InboundMessage } | { press: ButtonPress } | null {
  if (u.message) {
    const m = u.message
    if (!m.from || m.from.is_bot) return null
    const files: InboundFile[] = []
    if (m.document) files.push(fileOf(m.document, 'file', 'application/octet-stream'))
    if (m.photo && m.photo.length > 0) {
      const big = m.photo.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a))
      files.push(fileOf(big, `photo-${m.message_id}.jpg`, 'image/jpeg'))
    }
    if (m.audio) files.push(fileOf(m.audio, 'audio', 'audio/mpeg'))
    return {
      message: {
        updateId: String(u.update_id),
        conv: String(m.chat.id),
        from: { id: String(m.from.id), name: nameOf(m.from) },
        direct: m.chat.type === 'private' && m.chat.id === m.from.id,
        mentioned: false,
        text: m.text ?? m.caption ?? '',
        replyTo: m.reply_to_message ? String(m.reply_to_message.message_id) : null,
        files,
        voice: m.voice ? fileOf(m.voice, `voice-${m.message_id}.ogg`, 'audio/ogg') : null
      }
    }
  }
  if (u.callback_query) {
    const c = u.callback_query
    if (!c.message || c.from.is_bot) return null
    return {
      press: {
        pressId: c.id,
        conv: String(c.message.chat.id),
        from: { id: String(c.from.id), name: nameOf(c.from) },
        direct: c.message.chat.type === 'private' && c.message.chat.id === c.from.id,
        msg: String(c.message.message_id),
        token: c.data ?? ''
      }
    }
  }
  return null
}

const keyboard = (buttons?: Button[][]) =>
  buttons && buttons.length > 0
    ? { reply_markup: { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.label.slice(0, 64), callback_data: b.token }))) } }
    : {}

const refusedHtml = (err: unknown) =>
  err instanceof TelegramError &&
  err.code === 400 &&
  /parse entities|can't parse|unsupported start tag|can't find end/i.test(err.description)

export class TelegramAdapter implements ChannelAdapter {
  readonly platform = 'telegram' as const
  readonly sharedConvs = false
  readonly limits = { text: TELEGRAM_TEXT_MAX, uploadBytes: UPLOAD_MAX, downloadBytes: DOWNLOAD_MAX }
  private id: string | null = null
  private ctl: AbortController | null = null
  private loop: Promise<void> | null = null
  private drafts = true
  private readonly outbox: Outbox

  constructor(private readonly d: TelegramAdapterDeps) {
    this.outbox = new Outbox({
      gapMs: 1000,
      now: d.now,
      sleep: d.sleep,
      retryOf: (e) => (e instanceof TelegramError ? { code: e.code, retryAfter: e.retryAfter } : null)
    })
  }

  isShared(): boolean {
    return false
  }

  botId(): string | null {
    return this.id
  }

  start(sink: ChannelSink, offset: number, saveOffset: (next: number) => Promise<void>): void {
    if (this.loop) return
    const ctl = new AbortController()
    this.ctl = ctl
    this.loop = this.poll(sink, offset, saveOffset, ctl.signal).catch((err) =>
      this.d.log(`telegram poller stopped: ${err instanceof TelegramError ? err.code : 'error'}`)
    )
  }

  async stop(): Promise<void> {
    this.ctl?.abort()
    this.outbox.close()
    const loop = this.loop
    this.loop = null
    await loop
  }

  private async poll(sink: ChannelSink, start: number, saveOffset: (next: number) => Promise<void>, signal: AbortSignal): Promise<void> {
    let offset = start
    let backoff = 0
    let tries = 0
    const set = (s: ChannelState, bot: string | null = null) => sink.state(s, bot)
    const pause = async (ms: number) => {
      if (!signal.aborted) await Promise.race([this.d.sleep(ms), new Promise((r) => signal.addEventListener('abort', r, { once: true }))])
    }
    let bot: string | null = null
    while (!signal.aborted) {
      try {
        if (this.id === null) {
          set('connecting')
          const me = await this.d.api.call<{ id: number; username?: string }>('getMe', {}, { signal })
          this.id = String(me.id)
          bot = me.username ?? null
          // The menu: only ZumiBot's own commands. A failure costs only the menu.
          await this.d.api
            .call('setMyCommands', { commands: CHANNEL_COMMANDS.map((c) => ({ command: c.name, description: c.about })) }, { signal })
            .catch(() => undefined)
        }
        const updates = await this.d.api.call<TgUpdate[]>(
          'getUpdates',
          { offset, timeout: POLL_TIMEOUT_S, allowed_updates: ['message', 'callback_query'] },
          { signal, timeoutMs: (POLL_TIMEOUT_S + 15) * 1000 }
        )
        set('connected', bot)
        backoff = 0
        for (const u of updates) {
          if (signal.aborted) return
          const inbound = inboundOf(u)
          try {
            if (inbound && 'message' in inbound) await sink.message(inbound.message)
            else if (inbound) await sink.press(inbound.press)
            tries = 0
          } catch (err) {
            // Not confirmed: the same update comes back on the next poll. After a few failures it is skipped, so one
            // update that always fails can't stop every later one.
            if (++tries < HANDLE_TRIES) {
              this.d.log(`telegram update not handled, retrying: ${err instanceof Error ? err.message.slice(0, 120) : 'error'}`)
              await pause(2000)
              break
            }
            this.d.log('telegram update skipped after repeated failures')
            tries = 0
          }
          offset = u.update_id + 1
          // Written before the next getUpdates confirms it: a restart asks from here, and a redelivery is deduped by id.
          await saveOffset(offset)
        }
      } catch (err) {
        if (signal.aborted) return
        const code = err instanceof TelegramError ? err.code : -1
        if (code === 401 || code === 404) {
          set('badToken')
          this.d.log('telegram refused the bot token')
          return
        }
        if (code === 409) set('conflict')
        else set('error')
        backoff = code === 409 ? Math.min(300_000, Math.max(30_000, backoff * 2)) : Math.min(60_000, Math.max(2000, backoff * 2))
        const wait = code === 429 && err instanceof TelegramError && err.retryAfter ? err.retryAfter * 1000 : backoff
        this.d.log(`telegram poll failed (${code === 0 ? 'network' : code}), retrying in ${Math.round(wait / 1000)} s`)
        await pause(wait)
      }
    }
  }

  send(conv: string, text: OutText, o: { buttons?: Button[][]; replyTo?: string | null } = {}): Promise<string> {
    const base = {
      chat_id: conv,
      link_preview_options: { is_disabled: true },
      ...keyboard(o.buttons),
      ...(o.replyTo ? { reply_parameters: { message_id: Number(o.replyTo), allow_sending_without_reply: true } } : {})
    }
    return this.outbox
      .send(
        conv,
        async () => {
          try {
            return await this.d.api.call<{ message_id: number }>('sendMessage', { ...base, text: text.html, parse_mode: 'HTML' })
          } catch (err) {
            // HTML Telegram can't read goes again as its plain source, never lost.
            if (!refusedHtml(err)) throw err
            return await this.d.api.call<{ message_id: number }>('sendMessage', { ...base, text: text.plain.slice(0, TELEGRAM_TEXT_MAX) })
          }
        },
        { final: true }
      )
      .then((m) => String(m?.message_id ?? ''))
  }

  async draft(conv: string, draftId: number, text: OutText): Promise<boolean> {
    if (!this.drafts) return false
    let ok = true
    await this.outbox.send(
      conv,
      async () => {
        try {
          await this.d.api.call('sendMessageDraft', { chat_id: conv, draft_id: draftId, text: text.html, parse_mode: 'HTML' })
        } catch (err) {
          if (err instanceof TelegramError && (err.code === 429 || err.code === 0)) throw err
          // An older Bot API or a refused draft: no live preview from here on, only "typing…".
          if (!refusedHtml(err)) this.drafts = false
          ok = false
        }
      },
      { key: `draft:${draftId}` }
    )
    return ok && this.drafts
  }

  async typing(conv: string): Promise<void> {
    await this.outbox.send(conv, () => this.d.api.call('sendChatAction', { chat_id: conv, action: 'typing' }), { key: 'typing' })
  }

  async clearButtons(conv: string, msg: string): Promise<void> {
    await this.outbox.send(
      conv,
      () =>
        this.d.api
          .call('editMessageReplyMarkup', { chat_id: conv, message_id: Number(msg), reply_markup: { inline_keyboard: [] } })
          .catch((err) => {
            // "message is not modified" or a deleted message: nothing left to clear.
            if (err instanceof TelegramError && err.code === 400) return
            throw err
          }),
      { final: true }
    )
  }

  async setButtons(conv: string, msg: string, buttons: Button[][]): Promise<void> {
    await this.outbox.send(
      conv,
      () =>
        this.d.api.call('editMessageReplyMarkup', { chat_id: conv, message_id: Number(msg), ...keyboard(buttons) }).catch((err) => {
          if (err instanceof TelegramError && err.code === 400) return
          throw err
        }),
      { final: true }
    )
  }

  async edit(conv: string, msg: string, text: OutText, buttons: Button[][] | null): Promise<void> {
    const markup = buttons && buttons.length > 0 ? keyboard(buttons) : { reply_markup: { inline_keyboard: [] } }
    const base = { chat_id: conv, message_id: Number(msg), link_preview_options: { is_disabled: true }, ...markup }
    await this.outbox.send(
      conv,
      async () => {
        try {
          await this.d.api.call('editMessageText', { ...base, text: text.html, parse_mode: 'HTML' })
        } catch (err) {
          if (refusedHtml(err))
            return void (await this.d.api.call('editMessageText', { ...base, text: text.plain.slice(0, TELEGRAM_TEXT_MAX) }))
          // "message is not modified", or a message the user deleted: nothing to change.
          if (err instanceof TelegramError && err.code === 400) return
          throw err
        }
      },
      { final: true }
    )
  }

  ask(conv: string, text: OutText, replyTo: string | null): Promise<string> {
    return this.outbox
      .send(
        conv,
        () =>
          this.d.api.call<{ message_id: number }>('sendMessage', {
            chat_id: conv,
            text: text.html,
            parse_mode: 'HTML',
            reply_markup: { force_reply: true, input_field_placeholder: 'Your answer' },
            ...(replyTo ? { reply_parameters: { message_id: Number(replyTo), allow_sending_without_reply: true } } : {})
          }),
        { final: true }
      )
      .then((m) => String(m?.message_id ?? ''))
  }

  async ackPress(p: ButtonPress, notice?: string): Promise<void> {
    // Not through the per-chat queue: Telegram expects the answer quickly, and it is not a chat message.
    await this.d.api
      .call('answerCallbackQuery', { callback_query_id: p.pressId, ...(notice ? { text: notice.slice(0, 200) } : {}) })
      .catch(() => undefined)
  }

  sendFile(conv: string, name: string, bytes: Uint8Array, caption?: string): Promise<string> {
    return this.outbox
      .send(
        conv,
        () =>
          this.d.api.upload<{ message_id: number }>(
            'sendDocument',
            { chat_id: conv, ...(caption ? { caption: caption.slice(0, 1000) } : {}) },
            { field: 'document', name, bytes }
          ),
        { final: true }
      )
      .then((m) => String(m?.message_id ?? ''))
  }

  async fetchFile(f: InboundFile): Promise<Uint8Array> {
    if (f.size !== null && f.size > DOWNLOAD_MAX) throw new TelegramError('getFile', 413, null, 'too big')
    const info = await this.d.api.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: f.ref })
    if (!info.file_path) throw new TelegramError('getFile', 400, null, 'no path')
    return this.d.api.download(info.file_path, DOWNLOAD_MAX)
  }
}
