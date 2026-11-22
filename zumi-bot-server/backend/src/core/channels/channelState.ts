import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { CHANNEL_PLATFORMS, type ChannelPlatform } from '@zumibot/shared/channels'
import { writeFileAtomic } from '../fsutil'

/** A reply that was streaming to a channel when the server last ran: recovery tells the user it was cut. */
export interface OpenStream {
  chatId: string
  conv: string
  anchors: string[]
} // anchors: the channel messages whose turns stream back

export interface CardRecord {
  conv: string
  msg: string
  chatId: string
}

/** One platform's working state on this machine. */
export interface PlatformState {
  offset: number // Telegram: the next update_id to ask for; every lower one is confirmed
  current: Record<string, string> // conversation -> its current chat id
  msgs: [string, string, string][] // [conversation, platform message id, chat id], newest last: a reply to one goes to that chat
  open: OpenStream[]
  cards: CardRecord[] // card messages with buttons, cleared after a restart (their turns ended with it)
  cmds: string[] // update ids of the newest commands run: a command is recorded before it runs, so a redelivered one never runs twice
}

export const MSGS_KEPT = 2000

const empty = (): PlatformState => ({ offset: 0, current: {}, msgs: [], open: [], cards: [], cmds: [] })
export const CMDS_KEPT = 50

function readPlatform(raw: unknown): PlatformState {
  const out = empty()
  if (typeof raw !== 'object' || raw === null) return out
  const r = raw as Record<string, unknown>
  if (typeof r.offset === 'number' && Number.isSafeInteger(r.offset) && r.offset >= 0) out.offset = r.offset
  if (typeof r.current === 'object' && r.current !== null && !Array.isArray(r.current)) {
    for (const [k, v] of Object.entries(r.current)) if (k !== '__proto__' && typeof v === 'string') out.current[k] = v
  }
  if (Array.isArray(r.msgs))
    out.msgs = r.msgs
      .filter((m): m is [string, string, string] => Array.isArray(m) && m.length === 3 && m.every((x) => typeof x === 'string'))
      .slice(-MSGS_KEPT)
  if (Array.isArray(r.open)) {
    for (const o of r.open as Partial<OpenStream>[]) {
      if (typeof o !== 'object' || o === null || typeof o.chatId !== 'string' || typeof o.conv !== 'string') continue
      out.open.push({
        chatId: o.chatId,
        conv: o.conv,
        anchors: Array.isArray(o.anchors) ? o.anchors.filter((a): a is string => typeof a === 'string') : []
      })
    }
  }
  if (Array.isArray(r.cards))
    out.cards = r.cards
      .filter(
        (c): c is CardRecord =>
          typeof c === 'object' && c !== null && typeof c.conv === 'string' && typeof c.msg === 'string' && typeof c.chatId === 'string'
      )
      .slice(-200)
  if (Array.isArray(r.cmds)) out.cmds = r.cmds.filter((c): c is string => typeof c === 'string').slice(-CMDS_KEPT)
  return out
}

/** One platform's view of the state file: what ChannelService reads and writes. */
export interface PlatformStateView {
  get(): Promise<PlatformState>
  update(fn: (s: PlatformState) => void): Promise<PlatformState>
  /** The chat a bot message belongs to, if it is still remembered. */
  chatOfMessage(conv: string, msgId: string): Promise<string | null>
}

/**
 * channel-state.json (0600): per machine, never synced, one entry per platform. The update offset (written only once an
 * update is handled, so a restart neither replays nor drops one), the current chat of each conversation, which bot
 * message belongs to which chat, the replies still streaming, card messages with buttons and recent commands. Its values
 * mean nothing on another machine.
 */
export class ChannelStateStore {
  private readonly file: string
  private queue: Promise<unknown> = Promise.resolve()
  private state: Record<ChannelPlatform, PlatformState> | null = null

  constructor(dataDir: string) {
    this.file = join(dataDir, 'channel-state.json')
  }

  private run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op, op)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async read(): Promise<Record<ChannelPlatform, PlatformState>> {
    if (this.state) return this.state
    let raw: Record<string, unknown> = {}
    try {
      raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as Record<string, unknown>
    } catch {
      /* missing or unreadable: start from nothing (an offset of 0 asks for every unconfirmed update) */
    }
    const all = {} as Record<ChannelPlatform, PlatformState>
    for (const p of CHANNEL_PLATFORMS) all[p] = readPlatform(raw?.[p])
    this.state = all
    return all
  }

  view(p: ChannelPlatform): PlatformStateView {
    const get = (): Promise<PlatformState> => this.run(async () => structuredClone((await this.read())[p]))
    return {
      get,
      update: (fn) =>
        this.run(async () => {
          const all = await this.read()
          const next = structuredClone(all[p])
          fn(next)
          if (next.msgs.length > MSGS_KEPT) next.msgs = next.msgs.slice(-MSGS_KEPT)
          if (next.cmds.length > CMDS_KEPT) next.cmds = next.cmds.slice(-CMDS_KEPT)
          await writeFileAtomic(this.file, JSON.stringify({ v: 1, ...all, [p]: next }), 0o600)
          all[p] = next
          return structuredClone(next)
        }),
      chatOfMessage: async (conv, msgId) => {
        const s = await get()
        for (let i = s.msgs.length - 1; i >= 0; i--) if (s.msgs[i][0] === conv && s.msgs[i][1] === msgId) return s.msgs[i][2]
        return null
      }
    }
  }
}
