// Pure rules for Agent Studio's "What this agent loads" card: the tags a row shows, the cache note, which folder it opens on, and
// the edits of the agent's own servers and hooks. The card only draws them. Own-server and own-hook edits return a patch for the
// editor's `onFields`; an entry the file could not write is refused here, since `serializeAgent` would silently skip it.
import { assertNever, type Engine } from '@zumibot/shared/engine'
import {
  EXT_TEXT,
  type AgentOwnServer,
  type HookCommand,
  type HookGroup,
  type HookInput,
  type HookPosition,
  type HooksConfig,
  type Loadout,
  type LoadoutHook,
  type McpServerDef,
  type McpServerInput,
  type McpServerView
} from '@zumibot/shared/extensions'
import type { AgentFields } from '@zumibot/shared/frontmatter'
import type { VaultListItem } from '@zumibot/shared/vault'
import { type ExtensionTotals, type ServerRow, type SkillRow } from './extensions'
import type { HookSeed } from './extensionForms'

const ALWAYS_ON = 'Added by ZumiBot · always on'
const IN_FILE = "In this agent's file"

/** What a server row says instead of (or beside) a switch. */
export function serverTags(r: ServerRow): string[] {
  const tags: string[] = []
  if (r.source === 'zumibot') tags.push(ALWAYS_ON)
  else if (r.source === 'agent') tags.push(IN_FILE)
  // A fixed sentence from the loadout, such as why an own server was not started.
  if (r.note) tags.push(r.note)
  if (r.blockedByTools) tags.push("Not in this agent's tools list")
  return tags
}

/** A skill that is off globally has no switch (it cannot be forced on for one agent), so the row says why. */
export function skillTags(r: SkillRow): string[] {
  return r.on ? [] : ['Off for everyone']
}

/** Hooks of the global settings have no per-agent switch; a plugin's go with the plugin. */
export function hookTags(h: LoadoutHook): string[] {
  switch (h.source) {
    case 'plugin':
      return ['Turn off the plugin that adds it to drop it']
    case 'zumibot':
      return [ALWAYS_ON]
    case 'agent':
      return [IN_FILE]
    case 'user':
    case 'project':
    case 'local':
      return ['Applies to every agent']
    default:
      return []
  }
}

/** Why a card with no switches has none: a Codex agent has no per-agent choices, and Zumi Bot's setup is fixed. */
export function readOnlyNote(engine: Engine): string {
  switch (engine) {
    case 'claude':
      return "Zumi Bot's servers, skills and plugins are fixed, so this is a view only."
    case 'codex':
    case 'acp':
    case 'ag-ui':
      return 'Per-agent choices apply to Claude agents only.'
    default:
      return assertNever(engine)
  }
}

export const CACHE_NOTE = "Changing these makes the agent's next message re-read its whole context once."

const sorted = (list: string[] | null): string[] => [...(list ?? [])].sort()
const sortedEntries = (m: Record<string, boolean> | null): Array<[string, boolean]> =>
  Object.entries(m ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

/**
 * The note shown while the draft's off lists, plugin choices or own servers differ from the saved agent's: each changes the tool list
 * (and skills) the model sees, so the next message re-reads the whole context. Own hooks change no prompt, so they are left out.
 */
export function cacheNote(f: AgentFields, saved: AgentFields | null): string | null {
  if (saved === null) return null
  const same =
    JSON.stringify(sorted(f.serversOff)) === JSON.stringify(sorted(saved.serversOff)) &&
    JSON.stringify(sorted(f.skillsOff)) === JSON.stringify(sorted(saved.skillsOff)) &&
    JSON.stringify(sortedEntries(f.plugins)) === JSON.stringify(sortedEntries(saved.plugins)) &&
    JSON.stringify(f.mcpServers?.entries ?? []) === JSON.stringify(saved.mcpServers?.entries ?? [])
  return same ? null : CACHE_NOTE
}

/** What the probe depends on: it reads the saved file, so the card asks again when this changes (an own server or hook is part of what loads). */
export const loadoutKey = (saved: AgentFields | null): string =>
  saved === null ? 'none' : JSON.stringify([saved.serversOff, saved.skillsOff, saved.plugins, saved.mcpServers, saved.hooks])

/** The folder the card opens on: the agent's last one, else home. */
export const chooseFolder = (last: string | null, home: string): string => (last ? last : home)

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** The header line: "3 servers · 2 connected · 40 tools · 5 skills on (~1,200 tokens)". */
export function totalsText(t: ExtensionTotals): string {
  const skills = `${plural(t.skillsOn, 'skill', 'skills')} on`
  return [
    plural(t.servers, 'server', 'servers'),
    `${t.connected} connected`,
    plural(t.tools, 'tool', 'tools'),
    t.skillTokens > 0 ? `${skills} (~${t.skillTokens.toLocaleString('en-US')} tokens)` : skills
  ].join(' · ')
}

/** The API keys of the Vault granted to this agent, for the From Vault picker: name and env name, never a value; one per env name (the last by name wins, as the env does). */
export function vaultKeysOf(items: readonly VaultListItem[], agent: string): Array<{ env: string; name: string }> {
  const byEnv = new Map<string, string>()
  const keys = items
    .flatMap((i) => (i.kind === 'apiKey' && i.agents.includes(agent) ? [{ env: i.env, name: i.name }] : []))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  for (const k of keys) byEnv.set(k.env, k.name)
  return [...byEnv].map(([env, name]) => ({ env, name })).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

// ---- own servers ----

/** The form's input as the file's server definition: a null value means "keep the stored one", and a file has none. */
export function defOfInput(i: McpServerInput): McpServerDef {
  const def: McpServerDef = {}
  if (i.type !== undefined) def.type = i.type
  if (i.command !== undefined) def.command = i.command
  if (i.args !== undefined) def.args = [...i.args]
  if (i.url !== undefined) def.url = i.url
  // fromEntries makes own keys, so an odd name survives.
  const kept = (m: Record<string, string | null> | undefined): Record<string, string> | undefined => {
    const entries = Object.entries(m ?? {}).filter((e): e is [string, string] => e[1] !== null)
    return m === undefined ? undefined : Object.fromEntries(entries)
  }
  const env = kept(i.env)
  if (env) def.env = env
  const headers = kept(i.headers)
  if (headers) def.headers = headers
  return def
}

const transportOf = (d: McpServerDef): string => d.type ?? (d.url !== undefined && d.command === undefined ? 'http' : 'stdio')

export interface OwnServerRow {
  name: string
  /** The transport, or "already loaded" for a bare reference to a configured server. */
  detail: string
  /** True for an inline definition, the only kind the form edits. */
  inline: boolean
  note: string | null
}

/** The agent's own `mcpServers` entries with what the saved agent's loadout says about each (a clash with a loaded server, or why it was not started). */
export function ownServerRows(f: AgentFields, l: Loadout | null): OwnServerRow[] {
  return (f.mcpServers?.entries ?? []).map((e) => {
    const rows = (l?.servers ?? []).filter((s) => s.name === e.name)
    const clash = e.def !== null && rows.some((s) => s.source !== 'agent')
    const own = rows.find((s) => s.source === 'agent')
    return {
      name: e.name,
      detail: e.def === null ? 'already loaded' : transportOf(e.def),
      inline: e.def !== null,
      note: clash ? EXT_TEXT.sameName : (own?.note ?? null)
    }
  })
}

/** An inline entry as the form's view: no stored (hidden) values, since a file shows what it holds. The scope is unused in the file mode. */
export function ownServerSeed(e: AgentOwnServer & { def: McpServerDef }): McpServerView {
  return { name: e.name, scope: 'user', def: e.def, hidden: { env: [], headers: [] }, stamp: '' }
}

type Patch = { ok: true; patch: Partial<AgentFields> } | { ok: false; error: string }

// A block the file keeps but does not apply (its flag is false): serializeAgent would honour an explicit null and delete it, so no edit
// here may touch it (M1).
const KEPT_BLOCK = 'This block is kept as it is in the file. Edit it in the Raw view.'

const hasTarget = (d: McpServerDef): boolean => (d.command ?? '').trim() !== '' || (d.url ?? '').trim() !== ''

/**
 * The patch that adds an own server (`prev` null) or replaces one in place (a rename keeps its place). Refused: a block the file
 * keeps but does not apply, a name another entry has, and a definition with no command or URL (the file would skip it silently).
 */
export function saveOwnServer(f: AgentFields, prev: string | null, name: string, input: McpServerInput): Patch {
  if (f.mcpServers?.editable === false) return { ok: false, error: KEPT_BLOCK }
  const def = defOfInput(input)
  if (!hasTarget(def)) return { ok: false, error: 'Give the server a command or a URL.' }
  const entries = (f.mcpServers?.entries ?? []).map((e) => ({ ...e }))
  if (entries.some((e) => e.name === name && e.name !== prev))
    return { ok: false, error: `This agent already has a server called ${name}.` }
  const at = prev === null ? -1 : entries.findIndex((e) => e.name === prev)
  if (at === -1) entries.push({ name, def })
  else entries[at] = { name, def }
  return { ok: true, patch: { mcpServers: { entries, editable: true } } }
}

/** The patch that removes one own server; the last one removes the key. A block the file keeps but does not apply is refused (M1). */
export function removeOwnServer(f: AgentFields, name: string): Patch {
  if (f.mcpServers?.editable === false) return { ok: false, error: KEPT_BLOCK }
  const entries = (f.mcpServers?.entries ?? []).filter((e) => e.name !== name)
  return { ok: true, patch: { mcpServers: entries.length === 0 ? null : { entries, editable: true } } }
}

// ---- own hooks ----

export interface OwnHookRow {
  event: string
  group: number
  hook: number
  matcher: string
  command: string
  timeout: number | null
}

const commandOf = (h: HookGroup['hooks'][number]): HookCommand | null => {
  const c = h as Partial<HookCommand>
  return c.type === 'command' && typeof c.command === 'string' ? (c as HookCommand) : null
}

/** Every command hook of the agent's block, in file order, with its place. */
export function ownHookRows(f: AgentFields): OwnHookRow[] {
  const rows: OwnHookRow[] = []
  for (const [event, groups] of Object.entries(f.hooks?.config ?? {}))
    groups.forEach((g, group) =>
      g.hooks.forEach((h, hook) => {
        const c = commandOf(h)
        if (c)
          rows.push({
            event,
            group,
            hook,
            matcher: g.matcher ?? '',
            command: c.command,
            timeout: typeof c.timeout === 'number' ? c.timeout : null
          })
      })
    )
  return rows
}

/** A row as the hook form's seed; an own hook has no settings-file stamp. */
export const ownHookSeed = (r: OwnHookRow): HookSeed => ({
  event: r.event,
  matcher: r.matcher,
  command: r.command,
  timeout: r.timeout,
  at: { group: r.group, hook: r.hook },
  stamp: null
})

// A deep copy, so an edit never changes the fields the editor holds.
const cloneConfig = (c: HooksConfig | undefined): HooksConfig => JSON.parse(JSON.stringify(c ?? {})) as HooksConfig

const hookOf = (i: HookInput): HookCommand => ({
  type: 'command',
  command: i.command,
  ...(i.timeout !== undefined ? { timeout: i.timeout } : {})
})
const groupOf = (matcher: string, hook: HookCommand): HookGroup => ({ ...(matcher !== '' ? { matcher } : {}), hooks: [hook] })

const blockOf = (config: HooksConfig): Partial<AgentFields> => {
  // Empty groups and events are left out, so an emptied block drops the key.
  const kept = Object.fromEntries(Object.entries(config).filter(([, groups]) => groups.length > 0))
  return { hooks: Object.keys(kept).length === 0 ? null : { config: kept, editable: true } }
}

// An own-key read: the event name is data, so `constructor` or `toString` must not read Object.prototype (M2).
const groupsOf = (config: HooksConfig, event: string): HookGroup[] => (Object.hasOwn(config, event) ? config[event] : [])

/** The patch that adds a hook (its own group) or, with `at`, changes it where it is; a changed matcher moves it out of a group it shares. */
export function saveOwnHook(f: AgentFields, input: HookInput): Patch {
  if (f.hooks?.editable === false) return { ok: false, error: KEPT_BLOCK }
  const config = cloneConfig(f.hooks?.config)
  const hook = hookOf(input)
  const groups = groupsOf(config, input.event)
  const at = input.at
  const group = at ? groups[at.group] : undefined
  if (at && group && group.hooks[at.hook] !== undefined) {
    if ((group.matcher ?? '') === input.matcher) group.hooks[at.hook] = hook
    else {
      group.hooks.splice(at.hook, 1)
      if (group.hooks.length === 0) groups.splice(at.group, 1)
      groups.push(groupOf(input.matcher, hook))
    }
  } else groups.push(groupOf(input.matcher, hook))
  // An own property: the event name is data.
  Object.defineProperty(config, input.event, { value: groups, enumerable: true, writable: true, configurable: true })
  return { ok: true, patch: blockOf(config) }
}

/** The patch that removes the hook at a place; its group and event go when they empty, and an empty block removes the key. */
export function removeOwnHook(f: AgentFields, event: string, at: HookPosition): Patch {
  if (f.hooks?.editable === false) return { ok: false, error: KEPT_BLOCK }
  const config = cloneConfig(f.hooks?.config)
  const groups = groupsOf(config, event)
  const group = groups[at.group]
  if (group) {
    group.hooks.splice(at.hook, 1)
    if (group.hooks.length === 0) groups.splice(at.group, 1)
  }
  return { ok: true, patch: blockOf(config) }
}
