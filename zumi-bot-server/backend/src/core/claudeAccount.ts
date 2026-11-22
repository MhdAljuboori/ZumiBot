import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ClaudeAccount, ClaudeUsage, UsageWindow } from '@zumibot/shared/types'
import { writeFileAtomic } from './fsutil'
import type { RunEvent } from './chat/streamParser'

type Obj = Record<string, unknown>
// Usage as seen for one Claude account; accountUuid null = the account was unknown when it was seen.
type Seen = ClaudeUsage & { accountUuid: string | null }
export type UsageReading = Pick<ClaudeUsage, 'session' | 'weekly'>

/** The reading a Claude hook may record: a Codex-tagged event is Codex's plan, never Claude's. */
export function claudeUsageOf(e: Extract<RunEvent, { kind: 'rateLimit' }>): UsageReading | null {
  return e.provider ? null : { session: e.session, weekly: e.weekly }
}

export interface Profile {
  uuid: string
  name: string
  email: string
  plan: string | null
}

/** Claude Code's own config: the account it is signed in with, and its last fetch of the plan's limits. */
export function claudeConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env['CLAUDE_CONFIG_DIR']
  return dir ? join(dir, '.claude.json') : join(homedir(), '.claude.json')
}

const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** 'claude_pro' → 'Pro', 'claude_max' → 'Max'; anything else is not a plan name worth showing. */
export function planLabel(organizationType: unknown): string | null {
  const m = /^claude_([a-z_]+)$/.exec(typeof organizationType === 'string' ? organizationType : '')
  return m
    ? m[1]
        .split('_')
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ')
    : null
}

export function parseProfile(config: unknown): Profile | null {
  const a = obj(obj(config)?.['oauthAccount'])
  const uuid = text(a?.['accountUuid'])
  const email = text(a?.['emailAddress'])
  if (!a || !uuid || !email) return null
  return { uuid, email, name: text(a['displayName']) ?? text(a['fullName']) ?? email, plan: planLabel(a['organizationType']) }
}

// Claude Code keeps the usage endpoint's answer as is: utilization in percent, resets_at as an ISO date.
function cachedWindow(v: unknown): UsageWindow | null {
  const w = obj(v)
  const percent = num(w?.['utilization'])
  if (!w || percent === null) return null
  const at = typeof w['resets_at'] === 'string' ? Date.parse(w['resets_at']) : NaN
  return { percent, resetsAt: Number.isNaN(at) ? null : at }
}

export function parseCachedUsage(config: unknown): Seen | null {
  const c = obj(obj(config)?.['cachedUsageUtilization'])
  const u = obj(c?.['utilization'])
  const updatedAt = num(c?.['fetchedAtMs'])
  if (!c || !u || updatedAt === null) return null
  const session = cachedWindow(u['five_hour'])
  const weekly = cachedWindow(u['seven_day'])
  return session || weekly ? { session, weekly, updatedAt, accountUuid: text(c['accountUuid']) } : null
}

function ownWindow(v: unknown): UsageWindow | null {
  const w = obj(v)
  const percent = num(w?.['percent'])
  return w && percent !== null ? { percent, resetsAt: num(w['resetsAt']) } : null
}

function parseSeen(v: unknown): Seen | null {
  const s = obj(v)
  const updatedAt = num(s?.['updatedAt'])
  if (!s || updatedAt === null) return null
  return { session: ownWindow(s['session']), weekly: ownWindow(s['weekly']), updatedAt, accountUuid: text(s['accountUuid']) }
}

export interface AccountDeps {
  configFile: string
  usageFile: string // usage seen by chat turns here, kept across restarts
  osUser(): string
  now(): number
}

/**
 * The Claude account for the rail's Usage popover. Usage comes from whichever is newer: the last chat turn here (every
 * turn's stream carries the plan's limits) or Claude Code's own last fetch. Neither needs claude's login token.
 */
export class AccountService {
  private seen: Seen | null | undefined // undefined until usageFile is read
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly d: AccountDeps) {}

  private async config(): Promise<unknown> {
    try {
      return JSON.parse(await fs.readFile(this.d.configFile, 'utf8'))
    } catch {
      return null
    }
  }

  private async load(): Promise<Seen | null> {
    if (this.seen === undefined) {
      let raw: unknown = null
      try {
        raw = JSON.parse(await fs.readFile(this.d.usageFile, 'utf8'))
      } catch {
        /* none yet */
      }
      this.seen ??= parseSeen(raw) // a record() that landed during the read is newer
    }
    return this.seen
  }

  /** A chat turn's usage reading. Never throws: a failure only loses this one reading. */
  record(u: UsageReading): Promise<void> {
    const updatedAt = this.d.now()
    // Queued, so readings land in the order they came even though each first reads the config.
    const next = this.queue.then(async () => {
      const accountUuid = parseProfile(await this.config())?.uuid ?? null
      this.seen = { session: u.session, weekly: u.weekly, updatedAt, accountUuid }
      await fs.mkdir(dirname(this.d.usageFile), { recursive: true })
      await writeFileAtomic(this.d.usageFile, JSON.stringify(this.seen))
    })
    this.queue = next.catch((err: unknown) => console.error('saving usage failed:', err))
    return this.queue.then(() => undefined)
  }

  async account(): Promise<ClaudeAccount> {
    const config = await this.config()
    const profile = parseProfile(config)
    if (!profile) return { name: this.d.osUser(), email: null, plan: null, usage: null }
    const newest = [await this.load(), parseCachedUsage(config)]
      .filter((s): s is Seen => s !== null && s.accountUuid === profile.uuid)
      .reduce<Seen | null>((a, s) => (a && a.updatedAt >= s.updatedAt ? a : s), null)
    const usage = newest && { session: newest.session, weekly: newest.weekly, updatedAt: newest.updatedAt }
    return { name: profile.name, email: profile.email, plan: profile.plan, usage }
  }
}
