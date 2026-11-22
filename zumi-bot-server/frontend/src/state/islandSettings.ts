import { ISLAND_AGENTS_MAX, cleanHotkey } from '@zumibot/shared/island'
import { displayName } from '@zumibot/shared/frontmatter'
import type { AgentSummary } from '@zumibot/shared/types'

export interface PickRow {
  agent: AgentSummary
  picked: boolean
  index: number | null
  disabled: boolean
}

/** The picks whose agent exists, once the list is loaded: a pick whose file is gone can't be unticked, so it must not hold a slot of the cap, and the next save drops it. */
export function livePicks(picks: readonly string[], agents: readonly AgentSummary[]): string[] {
  return agents.length === 0 ? [...picks] : picks.filter((p) => agents.some((a) => a.name === p))
}

export function togglePick(picks: readonly string[], name: string): string[] {
  if (picks.includes(name)) return picks.filter((p) => p !== name)
  return picks.length >= ISLAND_AGENTS_MAX ? [...picks] : [...picks, name]
}

export function movePick(picks: readonly string[], name: string, by: -1 | 1): string[] {
  const i = picks.indexOf(name)
  const j = i + by
  if (i < 0 || j < 0 || j >= picks.length) return [...picks]
  const out = [...picks]
  ;[out[i], out[j]] = [out[j], out[i]]
  return out
}

/** The picker's list: picked agents in pick order, then the rest by name. A broken agent can't be added, but one already picked stays removable. */
export function pickRows(all: readonly string[], agents: readonly AgentSummary[]): PickRow[] {
  const picks = livePicks(all, agents)
  const full = picks.length >= ISLAND_AGENTS_MAX
  const picked: PickRow[] = []
  for (const [index, name] of picks.entries()) {
    const agent = agents.find((a) => a.name === name)
    if (agent) picked.push({ agent, picked: true, index, disabled: false })
  }
  const rest = agents
    .filter((a) => !picks.includes(a.name))
    .sort((a, b) => displayName(a.name).localeCompare(displayName(b.name), undefined, { sensitivity: 'base' }))
    .map((agent): PickRow => ({ agent, picked: false, index: null, disabled: agent.error !== null || full }))
  return [...picked, ...rest]
}

/**
 * The shortcut a key press spells, as the shell wants it, or null while it is not a shortcut yet (a modifier alone, no
 * modifier, or a key outside A-Z, 0-9, F1-F12 and Space). The physical key is read (`code`), so a layout or Shift does not change it.
 */
export function hotkeyFromKey(e: { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string | null {
  const m = /^(?:Key([A-Z])|Digit([0-9])|(F(?:[1-9]|1[0-2]))|(Space))$/.exec(e.code)
  const key = m?.[1] ?? m?.[2] ?? m?.[3] ?? m?.[4]
  if (!key) return null
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean)
  return cleanHotkey([...mods, key].join('+'))
}
