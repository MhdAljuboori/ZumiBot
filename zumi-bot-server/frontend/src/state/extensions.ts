// Pure rules for the Servers / Plugins / Skills / Hooks page and Agent Studio's "What this agent loads" card: grouping, the
// effective state of a row from the loadout plus the form's draft, the draft edits and the totals. Components only draw them.
import {
  toolPrefix,
  type HookSource,
  type Loadout,
  type LoadoutPlugin,
  type LoadoutServer,
  type LoadoutSkill,
  type ServerSource,
  type SkillSource
} from '@zumibot/shared/extensions'
import type { AgentFields } from '@zumibot/shared/frontmatter'

/** Where a row comes from, as the page's group headings and tags name it. The key order is the order of the groups. */
export const SOURCE_LABEL: Record<ServerSource | SkillSource | HookSource, string> = {
  user: 'You',
  local: 'This folder only',
  project: 'Project',
  plugin: 'Plugin',
  claudeai: 'claude.ai',
  agent: 'This agent',
  zumibot: 'Added by ZumiBot',
  bundled: 'Built in',
  other: 'Other'
}

const SOURCE_ORDER: string[] = Object.keys(SOURCE_LABEL)

/** Rows grouped by source in the fixed order above, each group in input order; an empty group is left out, and a source the map does not know goes last. */
export function groupBySource<T extends { source: string }>(rows: T[]): Array<{ source: T['source']; rows: T[] }> {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const list = groups.get(row.source)
    if (list) list.push(row)
    else groups.set(row.source, [row])
  }
  const rank = (source: string): number => {
    const at = SOURCE_ORDER.indexOf(source)
    return at === -1 ? SOURCE_ORDER.length : at
  }
  // Array.sort is stable, so unknown sources keep the order they first appeared in.
  return [...groups].sort(([a], [b]) => rank(a) - rank(b)).map(([source, list]) => ({ source, rows: list }))
}

/**
 * True when the agent's `tools:` list is a real list that names nothing of the server, so the CLI never offers it any of the
 * server's tools. No list (all tools) or an empty one blocks nothing.
 */
export function blockedByTools(tools: string[] | null, serverName: string): boolean {
  if (tools === null || tools.length === 0) return false
  const prefix = toolPrefix(serverName)
  return !tools.some((t) => t === prefix || t.startsWith(prefix + '__'))
}

export type ServerRow = LoadoutServer & { onForAgent: boolean; blockedByTools: boolean; toggleable: boolean }
export type SkillRow = LoadoutSkill & { onForAgent: boolean; toggleable: boolean }
export type PluginRow = LoadoutPlugin & { onForAgent: boolean; toggleable: boolean }

// ZumiBot's own servers are never editable, and an agent's own servers are removed in the agent's own-servers card, not switched.
const FIXED_SOURCES: ReadonlySet<string> = new Set(['zumibot', 'agent'])

/** Each server of the loadout with what the draft makes of it for this agent. */
export function agentServerRows(l: Loadout, f: AgentFields): ServerRow[] {
  const off = new Set(f.serversOff ?? [])
  return l.servers.map((s) => ({
    ...s,
    onForAgent: !off.has(s.name),
    blockedByTools: blockedByTools(f.tools, s.name),
    // A catalog connector is switched on its own page; the switch stays only while the draft still lists it off, so an old entry can be undone.
    toggleable: !FIXED_SOURCES.has(s.source) && (s.connector === null || off.has(s.name))
  }))
}

/** A skill that is off globally cannot be forced on for one agent, so only a skill that is on has a switch. */
export function agentSkillRows(l: Loadout, f: AgentFields): SkillRow[] {
  const off = new Set(f.skillsOff ?? [])
  return l.skills.map((s) => ({ ...s, onForAgent: s.on && !off.has(s.name), toggleable: s.on }))
}

// An own-key read: a plain `plugins[id]` would answer `toString`, `constructor` and `__proto__` from Object.prototype.
const pluginState = (plugins: Record<string, boolean> | null, id: string, globalEnabled: boolean): boolean =>
  plugins !== null && Object.hasOwn(plugins, id) ? plugins[id] : globalEnabled

/** A plugin's agent override beats its global state either way. */
export function agentPluginRows(l: Loadout, f: AgentFields): PluginRow[] {
  return l.plugins.map((p) => ({ ...p, onForAgent: pluginState(f.plugins, p.id, p.enabled), toggleable: true }))
}

function switchName(list: string[] | null, name: string, on: boolean): string[] | null {
  const kept = list ?? []
  // Off keeps a name at the place it already had; an empty list is null, so the key is dropped.
  const next = on ? kept.filter((n) => n !== name) : kept.includes(name) ? kept : [...kept, name]
  return next.length === 0 ? null : [...new Set(next)]
}

/** The draft's `serversOff` after switching one server for this agent: an empty list is null (the key is dropped). */
export function toggleServer(f: AgentFields, name: string, on: boolean): Partial<AgentFields> {
  return { serversOff: switchName(f.serversOff, name, on) }
}

export function toggleSkill(f: AgentFields, name: string, on: boolean): Partial<AgentFields> {
  return { skillsOff: switchName(f.skillsOff, name, on) }
}

/**
 * The draft's `plugins` map after switching one plugin. A choice equal to the global state is no override, so its entry goes;
 * an empty map is null. An existing entry keeps its place, and fromEntries makes own keys, so any id round-trips.
 */
export function togglePlugin(f: AgentFields, id: string, on: boolean, globalEnabled: boolean): Partial<AgentFields> {
  const entries = Object.entries(f.plugins ?? {})
  const override = on !== globalEnabled
  const next = entries.flatMap(([key, value]): Array<[string, boolean]> => (key !== id ? [[key, value]] : override ? [[key, on]] : []))
  if (override && !entries.some(([key]) => key === id)) next.push([id, on])
  return { plugins: next.length === 0 ? null : Object.fromEntries(next) }
}

export interface ExtensionTotals {
  servers: number
  connected: number
  tools: number
  skillsOn: number
  skillTokens: number
}

/**
 * The card's totals over what the run loads and uses for the agent: servers (and how many connected) and their tools, skills
 * and their tokens. A disabled server (an own server that was dropped) is not loaded and counts for nothing; a server the
 * `tools:` list leaves out still loads (and may be connected) but offers the model none of its tools.
 */
export function totals(servers: readonly ServerRow[], skills: readonly SkillRow[]): ExtensionTotals {
  const loaded = servers.filter((s) => s.onForAgent && s.status !== 'disabled')
  const skillsOn = skills.filter((s) => s.onForAgent)
  return {
    servers: loaded.length,
    connected: loaded.filter((s) => s.status === 'connected').length,
    tools: loaded.filter((s) => !s.blockedByTools).reduce((n, s) => n + s.tools.length, 0),
    skillsOn: skillsOn.length,
    skillTokens: skillsOn.reduce((n, s) => n + (s.tokens ?? 0), 0)
  }
}

/**
 * A plugin switched on in the draft is not in the saved agent's loadout, so the list cannot show what it adds until a Save.
 * An agent that was never saved has no loadout to compare, so there is nothing to hint.
 */
export function pluginHint(f: AgentFields, savedFields: AgentFields | null, id: string, globalEnabled: boolean): 'save-to-see' | null {
  if (savedFields === null) return null
  const now = pluginState(f.plugins, id, globalEnabled)
  const saved = pluginState(savedFields.plugins, id, globalEnabled)
  return now && !saved ? 'save-to-see' : null
}

const notApplied = (key: string): string => `Its ${key} block is kept in the file but not applied (its shape is not understood).`

/** The note for one block the editor cannot write back whole, read from its flag; null for a block that is absent or editable. */
export const blockNoteOf = (f: AgentFields, key: 'mcpServers' | 'hooks'): string | null =>
  f[key]?.editable === false ? notApplied(key) : null

/** What the card must say about an `mcpServers` or `hooks` block the editor cannot write back whole: the run applies none of it, so no row shows it. */
export function nonEditableNote(f: AgentFields): string[] {
  return (['mcpServers', 'hooks'] as const).flatMap((key) => blockNoteOf(f, key) ?? [])
}
