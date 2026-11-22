import { chatEngine, engineCaps, type Engine } from '@zumibot/shared/engine'
import { displayName } from '@zumibot/shared/frontmatter'
import type { AgentSummary, ChatMeta, ContextUse, GroupInfo, NextStart } from '@zumibot/shared/types'

/** From here the ring turns amber: the CLI compacts by itself near full. */
export const WARN_PERCENT = 75

export interface Meter {
  fraction: number // 0–1, how much of the ring is filled
  percent: number
  warn: boolean
  compacted: boolean // compacted since its last request: the size comes with the next one
  title: string
}

/** '950', '17K', '312K', '1M', '1.5M'. */
export function tokens(n: number): string {
  if (n < 1000) return String(n)
  const k = Math.round(n / 1000)
  if (k < 1000) return `${k}K`
  return `${Math.round(n / 100_000) / 10}M`
}

/** Where the meter counts as full: the agent's Compact at size when it is inside the window (the session compacts there). */
export const meterLimit = (window: number, compactAt: number | undefined): number =>
  compactAt !== undefined && compactAt < window ? compactAt : window

/** The popover's line on when the context compacts by itself; both engines honour the agent's Compact at size, but only Claude is named. */
export function selfCompactText(compactAt: number | undefined, window: number, engine: Engine): string {
  return compactAt !== undefined && compactAt < window
    ? `Compacts by itself at about ${tokens(compactAt)}, this agent's Compact at size (window ${tokens(window)}).`
    : `${engine === 'claude' ? 'Claude' : 'The agent'} compacts by itself when it is nearly full.`
}

/** `thread/compact/start` takes no note, so a Codex chat's Compact has nowhere to send one: no field for it. */
export const compactNoteShown = (engine: Engine): boolean => engine === 'claude'

/** The cold notice warns about the Claude prompt cache's hour: an engine with no such cache (Codex) has nothing to warn about. */
export const coldNoticeShown = (engine: Engine): boolean => engineCaps(engine).compact && engineCaps(engine).keepWarm

/** An agent's Compact at size (`autoCompactWindow`); undefined = the CLI's own, near the window. */
export const compactAtOf = (agents: readonly AgentSummary[], name: string): number | undefined =>
  agents.find((a) => a.name === name)?.autoCompactWindow

/** null: nothing to show yet (no turn reported it since it was cleared, or no window). */
export function contextMeter(c: ContextUse | undefined, compactAt?: number): Meter | null {
  if (!c || c.window === null) return null
  // After a compaction the CLI reports only the summary's size, so the ring waits for the next request.
  if (c.used === null) {
    const counts = c.compacted ? ` ${tokens(c.compacted.pre)} → ${tokens(c.compacted.post)}` : ''
    return { fraction: 0, percent: 0, warn: false, compacted: true, title: `Compacted${counts} · exact size after the next reply` }
  }
  const limit = meterLimit(c.window, compactAt)
  const fraction = Math.min(1, c.used / limit)
  const percent = Math.round(fraction * 100)
  const early = limit < c.window
  const title = !early
    ? `Context ${percent}% · ${tokens(c.used)} / ${tokens(c.window)}`
    : c.used >= limit
      ? `Context full · ${tokens(c.used)}, compacts on its next request`
      : `Context ${percent}% · ${tokens(c.used)} / ${tokens(limit)} before compacting`
  return { fraction, percent, warn: percent >= WARN_PERCENT, compacted: false, title }
}

/** A session to compact, and not one waiting to be seeded afresh. */
export const canCompact = (session: string | null | undefined, next: NextStart | undefined): boolean =>
  typeof session === 'string' && !(next !== undefined && 'seed' in next)

export interface MemberMeter {
  member: string
  meter: Meter | null
  canCompact: boolean
}

/** Every member of a room, in order, with its own meter (measured against its own Compact at size). */
export const memberMeters = (g: GroupInfo, agents: readonly AgentSummary[] = []): MemberMeter[] =>
  g.members.map((member) => ({
    member,
    meter: contextMeter(g.context?.[member], compactAtOf(agents, member)),
    canCompact: canCompact(g.sessions[member], g.next?.[member])
  }))

/** The room's ring: its fullest member's meter. */
export function fullest(rows: readonly MemberMeter[]): Meter | null {
  let best: Meter | null = null
  for (const { meter } of rows) if (meter && (best === null || meter.fraction > best.fraction)) best = meter
  return best
}

export interface CompactChoice {
  value: number | null
  label: string
  hint: string
  active: boolean
}

const COMPACT_SIZES: readonly [number, string][] = [
  [200_000, 'Cheapest'],
  [300_000, 'Lean'],
  [400_000, 'Balanced'],
  [600_000, 'Longest']
]

/**
 * Agent Studio's "Compact at": Default is the CLI's own (null, no key: compacts near the window's end) or a size; one set by
 * hand in the file shows as custom. Not "Auto": nothing chooses a size for the agent.
 */
export function compactChoices(current: number | null): CompactChoice[] {
  const out: CompactChoice[] = [
    { value: null, label: 'Default', hint: 'Near full', active: current === null },
    ...COMPACT_SIZES.map(([value, hint]) => ({ value, label: tokens(value), hint, active: current === value }))
  ]
  if (current !== null && !COMPACT_SIZES.some(([v]) => v === current))
    out.push({ value: current, label: `Custom: ${tokens(current)}`, hint: '', active: true })
  return out
}

/** The prompt cache lives an hour from a session's last request; after it, the next one writes the whole context again. */
export const CACHE_TTL_MS = 60 * 60_000
/** Smaller contexts reload cheaply enough to say nothing. */
export const COLD_MIN_TOKENS = 200_000

export interface ColdContext {
  member: string | null
  used: number
  since: number
}

/**
 * Contexts the next message would reload in full: big, idle past the cache's hour and compactable. Not one the CLI
 * compacts first anyway, because its agent's compact window is below its size.
 */
export function coldContexts(chat: ChatMeta, agents: readonly AgentSummary[], now: number): ColdContext[] {
  // A Codex session has no prompt-cache hour to keep warm.
  if (chat.inFlight || chat.sessionEngine !== undefined) return []
  const check = (
    member: string | null,
    agent: string,
    c: ContextUse | undefined,
    session: string | null | undefined,
    next: NextStart | undefined
  ): ColdContext[] => {
    if (!c || c.used === null || c.used < COLD_MIN_TOKENS || !canCompact(session, next)) return []
    const since = c.at ?? chat.replyAt ?? chat.updatedAt
    if (now - since < CACHE_TTL_MS) return []
    const own = compactAtOf(agents, agent)
    return own !== undefined && c.used >= own ? [] : [{ member, used: c.used, since }]
  }
  const g = chat.group
  if (!g) return check(null, chat.agentName, chat.context, chat.sessionId, chat.next)
  // Per member, as a single chat is judged as a whole: a Codex thread has no cache hour, and a member now on an engine without
  // one starts its next session afresh anyway.
  return g.members.flatMap((m) =>
    g.sessionEngines?.[m] !== undefined || !coldNoticeShown(chatEngine(chat, agents, m))
      ? []
      : check(m, m, g.context?.[m], g.sessions[m], g.next?.[m])
  )
}

const idle = (ms: number): string =>
  ms < 24 * CACHE_TTL_MS ? `${Math.floor(ms / CACHE_TTL_MS)} h` : `${Math.floor(ms / (24 * CACHE_TTL_MS))} d`

const joinNames = (parts: string[]): string =>
  parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`

/** The notice over the composer: what the next message costs and what compacting changes. */
export function coldNotice(rows: readonly ColdContext[], now: number): string {
  const since = now - Math.max(...rows.map((r) => r.since))
  if (rows.length === 1 && rows[0].member === null) {
    return `This chat's context is ${tokens(rows[0].used)} tokens and its cache expired (idle ${idle(since)}): your next message reloads all of it at full price. Compacting first makes every message after it much cheaper.`
  }
  const who = joinNames(rows.map((r) => `${displayName(r.member ?? '')} (${tokens(r.used)})`))
  return `The cache expired for ${who} (idle ${idle(since)}): whoever answers next reloads their whole context at full price. Compacting first makes every reply after it much cheaper.`
}
