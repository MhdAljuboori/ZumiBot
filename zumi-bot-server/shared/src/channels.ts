// Channels: Telegram (and later Slack) as another place to talk to the same agents. Types and pure rules shared by
// the server and Settings › Channels. See docs/architecture/channels.md.

export const CHANNEL_PLATFORMS = ['telegram', 'slack'] as const
export type ChannelPlatform = (typeof CHANNEL_PLATFORMS)[number]
export const isChannelPlatform = (v: unknown): v is ChannelPlatform =>
  typeof v === 'string' && (CHANNEL_PLATFORMS as readonly string[]).includes(v)

export const CHANNEL_LABELS: Record<ChannelPlatform, string> = { telegram: 'Telegram', slack: 'Slack' }

/** What the poller is doing. `conflict`: another machine polls this bot; `badToken`: the platform refused the token. */
export type ChannelState = 'off' | 'connecting' | 'connected' | 'conflict' | 'badToken' | 'vault' | 'error'

/** One platform as Settings › Channels shows it: never a token or a code. */
export interface ChannelStatus {
  platform: ChannelPlatform
  configured: boolean // a token is saved on this machine
  run: boolean // this machine runs the bot
  state: ChannelState
  bot: string | null // the bot's @username once connected
  paired: { name: string } | null
  pairing: { expiresAt: number } | null // an open pairing code (the code itself only goes to the page that asked)
  agents: string[] // agents that may be used from this channel
  sharedCards: boolean // Slack: cards also show in channels others can read (off: a link instead); Telegram: always false
  notify: import('./notify').ChannelNotifyToggles // which notifications also go to the paired chat; all off by default
}

/** ChatMeta.channel: the chat is linked to a channel conversation (only the sidebar mark reads it). */
export interface ChatChannelMark {
  platform: ChannelPlatform
}

// --- Tokens -------------------------------------------------------------------------------------------------------

// Telegram: <bot id>:<secret>. Slack: a bot token (xoxb-) and an app-level token (xapp-, for Socket Mode). Checked before
// any request, so a pasted sentence never reaches the platform.
const TELEGRAM_TOKEN_RE = /^\d{3,20}:[A-Za-z0-9_-]{30,64}$/
const SLACK_BOT_RE = /^xoxb-[A-Za-z0-9-]{10,250}$/
const SLACK_APP_RE = /^xapp-[A-Za-z0-9-]{10,250}$/
export function tokenShapeOk(platform: ChannelPlatform, token: string, appToken?: string): boolean {
  switch (platform) {
    case 'telegram':
      return TELEGRAM_TOKEN_RE.test(token) && appToken === undefined
    case 'slack':
      return SLACK_BOT_RE.test(token) && appToken !== undefined && SLACK_APP_RE.test(appToken)
  }
}

/** What a refused token is called in a message (never the token). */
export const TOKEN_NAMES: Record<ChannelPlatform, string> = { telegram: 'bot token', slack: 'bot or app token' }

/**
 * The character that starts a command. Slack's composer takes a leading `/` as one of its own slash commands and never
 * sends it, so Slack commands start with `!` (a `/` that does arrive works too).
 */
export const COMMAND_PREFIX: Record<ChannelPlatform, string> = { telegram: '/', slack: '!' }

// --- Pairing codes -------------------------------------------------------------------------------------------------

// No 0/O/1/I/L: a code read off a screen and typed on a phone.
export const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const PAIR_LEN = 8
export const PAIR_TTL_MS = 10 * 60_000
export const PAIR_TRIES_PER_SENDER = 5
export const PAIR_TRIES_WINDOW_MS = 10 * 60_000
export const PAIR_TRIES_TOTAL = 20

/** A code from random bytes (one per letter; the modulo bias over 31 letters is immaterial for a 10-minute, rate-limited code). */
export function pairCodeOf(bytes: Uint8Array): string {
  if (bytes.length < PAIR_LEN) throw new Error('pairCodeOf needs 8 bytes')
  let s = ''
  for (let i = 0; i < PAIR_LEN; i++) s += PAIR_ALPHABET[bytes[i] % PAIR_ALPHABET.length]
  return s
}

export const showPairCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`

/** The code a message holds, if its whole text is one (case, spaces and one dash ignored); else null. */
export function pairCodeIn(text: string): string | null {
  const s = text.replace(/[\s-]/g, '').toUpperCase()
  if (s.length !== PAIR_LEN) return null
  for (const c of s) if (!PAIR_ALPHABET.includes(c)) return null
  return s
}

// --- Commands ------------------------------------------------------------------------------------------------------

export type ChannelCommand =
  | { kind: 'help' }
  | { kind: 'agents' }
  | { kind: 'new'; agent: string | null }
  | { kind: 'chats' }
  | { kind: 'stop' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'where' }
  | { kind: 'unknown'; name: string }

export const CHANNEL_COMMANDS: { name: string; about: string }[] = [
  { name: 'agents', about: 'Agents you can use here' },
  { name: 'new', about: 'New chat: /new <agent>, or the current agent' },
  { name: 'chats', about: 'Recent chats to continue' },
  { name: 'where', about: 'The current chat' },
  { name: 'stop', about: 'Stop the running reply' },
  { name: 'pause', about: 'Pause the running reply' },
  { name: 'resume', about: 'Resume a paused chat' },
  { name: 'help', about: 'This list' }
]

/**
 * A message starting with `/` is a channel command, never text for the agent: channel text must not reach agent
 * commands, /todo, /btw or /compact. Null for any other message. Telegram adds `@botname` in groups; it is dropped.
 */
export function parseChannelCommand(text: string, platform: ChannelPlatform = 'telegram'): ChannelCommand | null {
  const t = text.trim()
  if (!t.startsWith('/') && !(platform === 'slack' && t.startsWith('!'))) return null
  const m = /^[/!]([A-Za-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(t)
  if (!m) return { kind: 'unknown', name: t.slice(1).split(/\s/)[0] ?? '' }
  const name = m[1].toLowerCase()
  const arg = (m[2] ?? '').trim()
  switch (name) {
    case 'help':
    case 'start':
      return { kind: 'help' }
    case 'agents':
      return { kind: 'agents' }
    case 'new':
      return { kind: 'new', agent: arg === '' ? null : arg }
    case 'chats':
      return { kind: 'chats' }
    case 'stop':
      return { kind: 'stop' }
    case 'pause':
      return { kind: 'pause' }
    case 'resume':
      return { kind: 'resume' }
    case 'where':
      return { kind: 'where' }
    default:
      return { kind: 'unknown', name }
  }
}

// --- Messages ------------------------------------------------------------------------------------------------------

/** The message id a channel update becomes (`MESSAGE_ID_RE`: letters, digits, dashes, at most 64): the same update always gives the same id, so a redelivery is dropped. */
export function channelMessageId(platform: ChannelPlatform, bot: string, updateId: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9]/g, '')
  return `ch-${platform === 'telegram' ? 'tg' : 'sl'}-${clean(bot)}-${clean(updateId)}`.slice(0, 64)
}

/** The longest text one channel message may send to an agent. */
export const CHANNEL_TEXT_MAX = 16_000
/** Files an agent changed are offered back up to this size. */
export const CHANNEL_FILE_MAX = 10 * 1024 * 1024
