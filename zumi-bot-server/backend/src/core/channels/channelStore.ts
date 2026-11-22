import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import { CHANNEL_PLATFORMS, type ChannelPlatform } from '@zumibot/shared/channels'
import { DEFAULT_CHANNEL_TOGGLES, type ChannelNotifyToggles } from '@zumibot/shared/notify'
import { writeFileAtomic } from '../fsutil'

/**
 * The paired account. Telegram: `userId` the user, `chatId` their private chat with the bot (the same number). Slack:
 * `userId` is `<team>:<user>`, `chatId` the DM channel the code came from.
 */
export interface ChannelPaired {
  userId: string
  chatId: string
  name: string
}
export interface ChannelSettings {
  run: boolean
  paired: ChannelPaired | null
  agents: string[]
  sharedCards: boolean // Slack: cards in channels others can read; off by default (a link goes there instead)
  notify: ChannelNotifyToggles // notifications that also go to the paired chat; all off by default
}
export type ChannelsSettings = Record<ChannelPlatform, ChannelSettings>
/** Phase 1's name for it; Telegram reads the same shape. */
export type TelegramSettings = ChannelSettings

const AGENTS_MAX = 200
const NAME_MAX = 200

const empty = (): ChannelSettings => ({ run: false, paired: null, agents: [], sharedCards: false, notify: { ...DEFAULT_CHANNEL_TOGGLES } })
const defaults = (): ChannelsSettings => ({ telegram: empty(), slack: empty() })

const ID_RE: Record<ChannelPlatform, RegExp> = {
  telegram: /^-?\d{1,20}$/,
  slack: /^[A-Z0-9]{2,30}(:[A-Z0-9]{2,30})?$/
}

/** Field by field: one bad value costs only itself. Zumi Bot is dropped from `agents` even if a file names it. */
function readPlatform(p: ChannelPlatform, raw: unknown): ChannelSettings {
  const out = empty()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  const t = raw as Record<string, unknown>
  if (typeof t.run === 'boolean') out.run = t.run
  if (typeof t.sharedCards === 'boolean' && p === 'slack') out.sharedCards = t.sharedCards
  // Toggle by toggle: an older file (no notify) or one bad value reads as off for just that kind.
  if (t.notify && typeof t.notify === 'object' && !Array.isArray(t.notify)) {
    const n = t.notify as Record<string, unknown>
    for (const k of Object.keys(DEFAULT_CHANNEL_TOGGLES) as (keyof ChannelNotifyToggles)[])
      if (typeof n[k] === 'boolean') out.notify[k] = n[k]
  }
  const pr = t.paired as Record<string, unknown> | null | undefined
  const idOk = (v: unknown): v is string => typeof v === 'string' && ID_RE[p].test(v)
  if (pr && typeof pr === 'object' && idOk(pr.userId) && idOk(pr.chatId) && typeof pr.name === 'string') {
    out.paired = { userId: pr.userId, chatId: pr.chatId, name: pr.name.slice(0, NAME_MAX) }
  }
  if (Array.isArray(t.agents)) {
    out.agents = [
      ...new Set(t.agents.filter((a): a is string => typeof a === 'string' && a !== '' && a.length <= NAME_MAX && a !== ZUMI_BOT_NAME))
    ].slice(0, AGENTS_MAX)
  }
  return out
}

/**
 * channels.json: per platform, which machine runs the bot, the paired account, the agents allowed from it and (Slack)
 * whether cards show in shared channels. No secret (tokens are sealed apart, see ChannelTokens). The copy sync writes on
 * the PC has `run` off.
 */
export class ChannelStore {
  private readonly file: string
  private queue: Promise<unknown> = Promise.resolve()
  private cache: ChannelsSettings | null = null

  constructor(dataDir: string) {
    this.file = join(dataDir, 'channels.json')
  }

  private run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op, op)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async read(): Promise<ChannelsSettings> {
    if (this.cache) return this.cache
    let raw: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as unknown
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>
    } catch {
      /* missing or unreadable: the defaults, everything off */
    }
    const all = defaults()
    for (const p of CHANNEL_PLATFORMS) all[p] = readPlatform(p, raw[p])
    this.cache = all
    return all
  }

  get(): Promise<ChannelsSettings> {
    return this.run(async () => structuredClone(await this.read()))
  }

  async platform(p: ChannelPlatform): Promise<ChannelSettings> {
    return (await this.get())[p]
  }

  /** One write under the queue; `fn` returns the new settings for that platform, or null for no change. */
  update(p: ChannelPlatform, fn: (cur: ChannelSettings) => ChannelSettings | null): Promise<ChannelSettings> {
    return this.run(async () => {
      const all = structuredClone(await this.read())
      const next = fn(all[p])
      if (next === null) return all[p]
      all[p] = readPlatform(p, next)
      await writeFileAtomic(this.file, JSON.stringify({ v: 1, ...all }, null, 2), 0o600)
      this.cache = all
      return structuredClone(all[p])
    })
  }

  /** The agent-rename pipeline: a renamed agent keeps its channel switches. */
  async renameAgent(from: string, to: string): Promise<void> {
    for (const p of CHANNEL_PLATFORMS)
      await this.update(p, (t) => (t.agents.includes(from) ? { ...t, agents: t.agents.map((a) => (a === from ? to : a)) } : null))
  }

  /** A deleted agent's switches go with it. */
  async forgetAgents(names: readonly string[]): Promise<void> {
    for (const p of CHANNEL_PLATFORMS)
      await this.update(p, (t) =>
        t.agents.some((a) => names.includes(a)) ? { ...t, agents: t.agents.filter((a) => !names.includes(a)) } : null
      )
  }
}
