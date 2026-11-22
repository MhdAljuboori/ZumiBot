import { ZUMI_BOT_NAME } from './zumiBot'
import { displayName } from './frontmatter'
import type { AgentSummary } from './types'

export type AgentMatch = { ok: true; name: string } | { ok: false; reason: 'unknown' | 'zumi-bot' }

const loose = (s: string): string => s.trim().replace(/^@/, '').replace(/\s+/g, ' ').toLowerCase()

/**
 * Finds the agent a person named, by file name or display name: the exact name first, else the one agent whose name or
 * display name matches without case. A broken file can't run, so it is as unknown as a missing one; Zumi Bot is never
 * returned (it gets its own reason, so callers can word the refusal). Several hits are unknown, never a guess.
 */
export function matchAgent(named: string, agents: readonly Pick<AgentSummary, 'name' | 'error'>[]): AgentMatch {
  const loadable = agents.filter((a) => a.error === null && a.name !== ZUMI_BOT_NAME)
  const exact = loadable.find((a) => a.name === named.trim().replace(/^@/, ''))
  if (exact) return { ok: true, name: exact.name }
  const want = loose(named)
  if (want === ZUMI_BOT_NAME || want === displayName(ZUMI_BOT_NAME).toLowerCase()) return { ok: false, reason: 'zumi-bot' }
  const hits = loadable.filter((a) => a.name.toLowerCase() === want || displayName(a.name).toLowerCase() === want)
  return hits.length === 1 ? { ok: true, name: hits[0]!.name } : { ok: false, reason: 'unknown' }
}
