import type { ChannelPlatform, ChannelState } from '@zumibot/shared/channels'

// The one interface a platform implements. Everything above it (routing, pairing, streams) is platform-free.

export interface ChannelUser {
  id: string
  name: string
}

/** A file a message carries: fetched only when used, refused past the adapter's download limit. */
export interface InboundFile {
  ref: string
  name: string
  mime: string
  size: number | null
}

export interface InboundMessage {
  updateId: string // unique per bot; becomes the message id, so a redelivery is dropped
  conv: string // the conversation (Telegram: the chat id)
  from: ChannelUser
  direct: boolean // a one-to-one chat between the sender and the bot
  mentioned: boolean // the message names the bot (Slack: `<@bot>` in a channel); always false on Telegram
  text: string
  replyTo: string | null // the bot message this one replies to
  files: InboundFile[]
  voice: InboundFile | null
}

export interface ButtonPress {
  pressId: string
  conv: string
  from: ChannelUser
  direct: boolean
  msg: string | null
  token: string
}

/** One message's text: the HTML the platform renders, and the plain fallback when the HTML is refused. */
export interface OutText {
  html: string
  plain: string
}
export interface Button {
  label: string
  token: string
}

export interface ChannelSink {
  /** Resolves once the message is durably handled; the adapter confirms the update only then. */
  message(m: InboundMessage): Promise<void>
  press(p: ButtonPress): Promise<void>
  state(s: ChannelState, bot: string | null): void
}

export interface ChannelAdapter {
  readonly platform: ChannelPlatform
  /** Conversations other people can read exist on this platform (Slack channels); false on Telegram. */
  readonly sharedConvs: boolean
  /** This conversation is a thread in a channel others can read. */
  isShared(conv: string): boolean
  readonly limits: { text: number; uploadBytes: number; downloadBytes: number }
  /** The bot's id (part of every message id) once `start` connected; null before. */
  botId(): string | null
  start(sink: ChannelSink, offset: number, saveOffset: (next: number) => Promise<void>): void
  stop(): Promise<void>
  send(conv: string, text: OutText, o?: { buttons?: Button[][]; replyTo?: string | null }): Promise<string>
  /** A live preview of a reply being written; resolves false when the platform has none (the caller falls back). */
  draft(conv: string, draftId: number, text: OutText): Promise<boolean>
  /** "typing…" for a few seconds, where the platform shows one. */
  typing(conv: string): Promise<void>
  /** Removes a message's buttons (a list whose tokens were used, or one that went stale). */
  clearButtons(conv: string, msg: string): Promise<void>
  /** Replaces a message's buttons (a multi-select's ticks). */
  setButtons(conv: string, msg: string, buttons: Button[][]): Promise<void>
  /** Replaces a message's text; `buttons` null removes them. A card's outcome. */
  edit(conv: string, msg: string, text: OutText, buttons: Button[][] | null): Promise<void>
  /** A message the user's next message answers (Telegram's ForceReply). */
  ask(conv: string, text: OutText, replyTo: string | null): Promise<string>
  ackPress(p: ButtonPress, notice?: string): Promise<void>
  /** A display name for Settings once paired (Slack's events carry only ids); absent: `from.name` is already one. */
  userName?(u: ChannelUser): Promise<string>
  sendFile(conv: string, name: string, bytes: Uint8Array, caption?: string): Promise<string>
  fetchFile(f: InboundFile): Promise<Uint8Array>
}
