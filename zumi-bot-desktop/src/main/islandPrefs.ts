import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { cleanAgentList, cleanHotkey } from '@zumibot/shared/island'

/** `agents` is keyed by server origin, so the Local and VPS choices each keep their own strip. */
export interface IslandPrefs {
  v: 1
  startAtLogin: boolean
  top: number | null
  agents: Record<string, string[]>
  voiceHotkey: string | null
}

export const DEFAULT_VOICE_HOTKEY = 'Ctrl+Alt+Space'

export const DEFAULT_ISLAND_PREFS: IslandPrefs = { v: 1, startAtLogin: true, top: null, agents: {}, voiceHotkey: DEFAULT_VOICE_HOTKEY }

// Lenient: a hand-edited or older file loses only the field that is wrong.
export function parseIslandPrefs(raw: unknown): IslandPrefs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_ISLAND_PREFS, agents: {} }
  const r = raw as Record<string, unknown>
  const agents: Record<string, string[]> = {}
  if (r.agents && typeof r.agents === 'object' && !Array.isArray(r.agents)) {
    for (const [origin, list] of Object.entries(r.agents)) {
      const clean = cleanAgentList(list)
      if (clean) agents[origin] = clean
    }
  }
  return {
    v: 1,
    startAtLogin: typeof r.startAtLogin === 'boolean' ? r.startAtLogin : DEFAULT_ISLAND_PREFS.startAtLogin,
    top: typeof r.top === 'number' && Number.isFinite(r.top) ? r.top : null,
    agents,
    // null is a choice (off); anything else that is not a valid accelerator is the default.
    voiceHotkey: r.voiceHotkey === null ? null : (cleanHotkey(r.voiceHotkey) ?? DEFAULT_VOICE_HOTKEY)
  }
}

export function loadIslandPrefs(file: string): IslandPrefs {
  try {
    return parseIslandPrefs(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return parseIslandPrefs(null)
  }
}

export function saveIslandPrefs(file: string, p: IslandPrefs): void {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, JSON.stringify(p), { mode: 0o600 })
  renameSync(tmp, file)
}

export const agentsFor = (p: IslandPrefs, origin: string): string[] => p.agents[origin] ?? []

export const withAgents = (p: IslandPrefs, origin: string, list: string[]): IslandPrefs => ({
  ...p,
  agents: { ...p.agents, [origin]: list }
})

/** Renames in place, keeping the order; if `to` is already listed, the entry first in the list stays and the later duplicate is dropped. */
export function renameAgentIn(p: IslandPrefs, origin: string, from: string, to: string): IslandPrefs {
  const list = agentsFor(p, origin)
  if (!list.includes(from)) return p
  const renamed = list.map((a) => (a === from ? to : a))
  return withAgents(
    p,
    origin,
    renamed.filter((a, i) => renamed.indexOf(a) === i)
  )
}
