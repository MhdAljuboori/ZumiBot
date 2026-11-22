// Spend caps (see the spend caps design spec): pure rules shared by the server and the page.
import { displayName } from './agentName'
import { PAUSE_MARKER } from './pause'

/** The highest cap the editors and the agent file take, in USD. */
export const SPEND_CAP_MAX = 10_000

/** A cap amount, rounded to cents: a finite number (or numeric text) above 0 and at most SPEND_CAP_MAX; anything else is no cap. */
export function parseSpendCap(v: unknown): number | null {
  if (typeof v === 'string' && v.trim() === '') return null
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim().replace(/^\$/, '')) : NaN
  if (!Number.isFinite(n)) return null
  const cents = Math.round(n * 100) / 100
  return cents > 0 && cents <= SPEND_CAP_MAX ? cents : null
}

/** "$5.00": always cents, since every cap is a whole number of cents. */
export function capUsd(n: number): string {
  const v = Number.isFinite(n) && n > 0 ? n : 0
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** What a cap covers. `agent` is a day's spend of one agent; the others one run. */
export type CapScope =
  | { kind: 'workflow'; workflowId: string; runId: string }
  | { kind: 'routine'; routineId: string; runId: string }
  | { kind: 'agent'; agent: string; day: string }

/** Why a chat's pause was asked by a cap: stored with the pause (ChatMeta.pauseCap), shown in its notice. */
export interface CapPause {
  scope: CapScope
  label: string // the workflow's or routine's name, or the agent's handle
  spentUsd: number
  limitUsd: number
  capUsd: number
}

/** A workflow run a cap holds: nothing new starts in it until Continue. `agent`: an agent's day, not the run's own cap. */
export interface CapHold {
  kind: 'run' | 'agent'
  agent?: string
  at: number
  spentUsd: number
  limitUsd: number
  capUsd: number
}

/** What a capped run or day may spend: the cap, or a higher limit Continue or Resume set. */
export const effectiveLimit = (cap: number, raised: number | undefined): number => Math.max(cap, raised ?? 0)

/** Going on past a cap allows one more cap's worth from what was spent. */
export const raisedLimit = (spentUsd: number, cap: number): number => Math.round((Math.max(0, spentUsd) + cap) * 100) / 100

/** Reached once what was spent is at the limit; a cent of float noise below it does not count as under. */
export const reached = (spentUsd: number, limitUsd: number): boolean => spentUsd >= limitUsd - 1e-9

/** What the pause hook tells the agent while a cap pauses it. Carries PAUSE_MARKER, so the server counts its blocks as a pause's. */
export const CAP_BLOCK_TEXT = `A spend cap paused this task ${PAUSE_MARKER}. Do not start any tool or subagent. In a few lines, say where the task stands and what the next step is, then end your reply.`

/** The pause flag file's content when a cap asked the pause; empty for the user's own. */
export const CAP_FLAG = 'cap'

const scopeWords = (c: CapPause): string => {
  switch (c.scope.kind) {
    case 'workflow':
      return `Workflow “${c.label}” spent ${capUsd(c.spentUsd)} of its ${capUsd(c.limitUsd)} cap for this run`
    case 'routine':
      return `Routine “${c.label}” spent ${capUsd(c.spentUsd)} of its ${capUsd(c.limitUsd)} cap for this run`
    case 'agent':
      return `@${displayName(c.label)} spent ${capUsd(c.spentUsd)} of its ${capUsd(c.limitUsd)} daily cap`
  }
}

/** The notice a cap's pause lands with, in place of "Paused. Press Resume to continue." */
export function capPausedText(c: CapPause): string {
  return `Spend cap reached: ${scopeWords(c)}. Press Resume to continue; it allows ${capUsd(c.capUsd)} more.`
}

/** A notification's body for a cap that was reached. */
export function capNoticeBody(c: Pick<CapPause, 'scope' | 'spentUsd' | 'limitUsd'>): string {
  return c.scope.kind === 'agent'
    ? `Daily spend cap reached: ${capUsd(c.spentUsd)} of ${capUsd(c.limitUsd)}. Its running replies are paused.`
    : `Paused at its spend cap: ${capUsd(c.spentUsd)} of ${capUsd(c.limitUsd)}.`
}

/** Why a routine run never started: an agent it runs is past its daily cap. */
export const capSkipText = (agent: string): string => `@${displayName(agent)} reached its daily spend cap`

// Offset of a zone (ms east of UTC) at an instant, read back through Intl: no date library.
function offsetAt(ms: number, timeZone: string): number {
  const p: Record<string, number> = {}
  for (const x of new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric'
  }).formatToParts(new Date(ms)))
    if (x.type !== 'literal') p[x.type] = Number(x.value)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000
}

const zoneOr = (timeZone: string): string => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return timeZone
  } catch {
    return 'UTC'
  }
}

/** The calendar day of `now` in the zone, 'YYYY-MM-DD', and its local midnight as UTC ms. An unknown zone is UTC. */
export function dayOf(now: number, timeZone: string): { day: string; start: number } {
  const zone = zoneOr(timeZone)
  const local = new Date(now + offsetAt(now, zone))
  const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate())
  // The offset can differ at midnight from now's (DST), so settle it with a second pass.
  let start = wall - offsetAt(wall, zone)
  start = wall - offsetAt(start, zone)
  return { day: new Date(wall).toISOString().slice(0, 10), start }
}

/** One agent's day as Settings › Usage shows it. limitUsd: the cap, or what Allow more today raised it to. */
export interface AgentCapStatus {
  agent: string
  capUsd: number
  limitUsd: number
  spentUsd: number
  over: boolean
}
