// Pure rules for Settings › Claude Code: the tabs, how a row reads and what it may do. Components only draw them.
import {
  EXT_TEXT,
  type HookFile,
  type Loadout,
  type LoadoutHook,
  type LoadoutPlugin,
  type LoadoutSection,
  type LoadoutServer,
  type LoadoutSkill,
  type McpScope,
  type ServerStatus
} from '@zumibot/shared/extensions'

export const TAB_ORDER: readonly LoadoutSection[] = ['servers', 'plugins', 'skills', 'hooks']
export const TAB_LABEL: Record<LoadoutSection, string> = { servers: 'Servers', plugins: 'Plugins', skills: 'Skills', hooks: 'Hooks' }

/** The tab an arrow, Home or End key moves to (roving focus, wrapping), or null for any other key. */
export function tabKeyTarget(key: string, current: LoadoutSection): LoadoutSection | null {
  const at = TAB_ORDER.indexOf(current)
  const n = TAB_ORDER.length
  if (key === 'ArrowRight') return TAB_ORDER[(at + 1) % n]
  if (key === 'ArrowLeft') return TAB_ORDER[(at + n - 1) % n]
  if (key === 'Home') return TAB_ORDER[0]
  if (key === 'End') return TAB_ORDER[n - 1]
  return null
}

export type StatusTone = 'ok' | 'warn' | 'bad' | 'busy' | 'idle'

const STATUS: Record<ServerStatus, { label: string; tone: StatusTone }> = {
  connected: { label: 'Connected', tone: 'ok' },
  'needs-auth': { label: 'Needs sign-in', tone: 'warn' },
  failed: { label: 'Failed', tone: 'bad' },
  pending: { label: 'Connecting…', tone: 'busy' },
  disabled: { label: 'Off', tone: 'idle' },
  unknown: { label: 'Unknown', tone: 'idle' }
}

export const statusInfo = (status: ServerStatus): { label: string; tone: StatusTone } => STATUS[status]

/** Where a new server can be saved. */
export const SCOPE_LABEL: Record<McpScope, string> = {
  user: 'You: available in every folder',
  // The CLI files local servers under the repo root (Ruling 21), so they follow the project, not the folder.
  local: 'This project, only for you',
  project: 'This folder, shared with the project (.mcp.json)'
}

const CONNECTORS = 'claude.ai › Settings › Connectors'
const NOT_EDITABLE = 'Not editable here'
const PLUGIN_NOTE = (plugin: string | null): string => (plugin ? `Comes with plugin ${plugin}` : 'Comes with a plugin')

/** The name as a shell would take it: plain names as they are, anything else in single quotes. */
const shellWord = (name: string): string => (/^[A-Za-z0-9_.:@-]+$/.test(name) ? name : `'${name.replace(/'/g, `'\\''`)}'`)

export const loginCommand = (name: string): string => `claude mcp login ${shellWord(name)}`

export interface ServerRowInfo {
  /** The scope Edit and Remove work in; null when the page cannot change this server. */
  scope: McpScope | null
  /** Where to change a server this page cannot. */
  note: string | null
  signIn: string | null
}

/** What a server row may do: only a server of the user's own files has actions, and the rest say where to change it. */
export function serverRow(s: LoadoutServer): ServerRowInfo {
  const own = s.source === 'user' || s.source === 'local' || s.source === 'project'
  const signIn =
    s.status !== 'needs-auth'
      ? null
      : s.source === 'claudeai'
        ? `Sign in from ${CONNECTORS}`
        : `Sign in from a terminal: ${loginCommand(s.name)}`
  if (own && s.scope !== null) return { scope: s.scope, note: null, signIn }
  // A row of the user's own files the loadout made read-only says why (a parent folder's .mcp.json, a linked file).
  const note =
    s.source === 'plugin'
      ? PLUGIN_NOTE(s.plugin)
      : s.source === 'claudeai'
        ? `Manage in ${CONNECTORS}`
        : own && s.note
          ? s.note
          : NOT_EDITABLE
  return { scope: null, note, signIn }
}

export const toolsText = (n: number): string => (n === 0 ? 'No tools' : n === 1 ? '1 tool' : `${n} tools`)

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/**
 * What a plugin adds. A plugin that is off loads nothing, so it has nothing to count. `on` is its state where it shows: the global
 * switch on the Settings page, the agent's own (the draft's) in the agent card, where a plugin on for everyone may be off for the agent.
 */
export function pluginLine(p: LoadoutPlugin, on: boolean | null = null): string {
  if (on === false) return 'Off for this agent'
  if (on === null && !p.enabled && p.skills + p.servers + p.hooks === 0) return 'Switch it on to see what it adds'
  return [count(p.skills, 'skill', 'skills'), count(p.servers, 'server', 'servers'), count(p.hooks, 'hook', 'hooks')].join(' · ')
}

export const tokensText = (tokens: number | null): string | null =>
  tokens === null ? null : `${tokens.toLocaleString('en-US')} ${tokens === 1 ? 'token' : 'tokens'}`

export interface SkillRowInfo {
  /** The scope the editor works in; null for a skill this page cannot edit. */
  scope: 'user' | 'project' | null
  note: string | null
}

export function skillRow(s: LoadoutSkill): SkillRowInfo {
  if (s.editable && (s.source === 'user' || s.source === 'project')) return { scope: s.source, note: null }
  const note =
    s.source === 'plugin'
      ? PLUGIN_NOTE(s.plugin)
      : s.source === 'claudeai'
        ? 'Synced from claude.ai'
        : s.source === 'bundled'
          ? 'Built into Claude Code'
          : NOT_EDITABLE
  return { scope: null, note }
}

/** A command on one line: white space collapsed, a long one cut with an ellipsis. */
export function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

export interface HookRowInfo {
  /** The settings file Edit and Remove write to; null when the row is read-only. */
  file: HookFile | null
  editable: boolean
  note: string | null
  matcher: string
  line: string
  timeout: string | null
}

/** Only a command hook that sits at a known place of a settings file, with that file's stamp, can be changed here. */
export function hookRow(h: LoadoutHook): HookRowInfo {
  const file: HookFile | null = h.source === 'user' || h.source === 'project' || h.source === 'local' ? h.source : null
  const editable = file !== null && h.type === 'command' && h.at !== null && h.stamp !== null
  return {
    file: editable ? file : null,
    editable,
    note: editable ? null : h.source === 'plugin' ? 'Plugin hooks follow their plugin' : NOT_EDITABLE,
    matcher: h.matcher === '' ? 'Every tool' : h.matcher,
    line: oneLine(h.command),
    timeout: h.timeout === null ? null : `${h.timeout} s`
  }
}

/** A switch the user just flipped: the state it was asked for, and the loadout it was asked against. */
export interface PendingSwitch {
  on: boolean
  at: number
}

/**
 * What a switch shows. A write answers before the probe that reflects it, so the asked state shows until a newer loadout lands;
 * from then on the loadout is the truth (even if it differs: the CLI may have refused).
 */
export const shownOn = (current: boolean, pending: PendingSwitch | undefined, loadoutAt: number | null): boolean =>
  pending !== undefined && pending.at === loadoutAt ? pending.on : current

/** The settings files a hook can be written to. */
export const HOOK_FILE_LABEL: Record<HookFile, string> = {
  user: 'Your settings (~/.claude/settings.json)',
  project: 'This project (.claude/settings.json)',
  local: 'This folder, only for you (.claude/settings.local.json)'
}

const SERVER_FROM: Record<McpScope, string> = {
  user: 'your own servers',
  local: 'this project (only for you)',
  project: 'this folder’s .mcp.json'
}
const HOOK_FROM: Record<HookFile, string> = {
  user: 'your settings',
  project: 'this project’s settings',
  local: 'this folder’s local settings'
}

/** The confirm texts for removals. */
export const removeText = {
  server: (name: string, scope: McpScope): string =>
    scope === 'project'
      ? `Remove ${name} from ${SERVER_FROM.project}? Everyone who uses the project stops getting it.`
      : `Remove ${name} from ${SERVER_FROM[scope]}? Claude Code stops loading it.`,
  skill: (name: string): string => `Move the ${name} skill, with its whole folder, to the Trash?`,
  hook: (event: string, file: HookFile): string => `Remove this ${event} hook from ${HOOK_FROM[file]}?`
}

// ZumiBot's own additions and an agent's own rows belong to a run of one agent, not to a folder: this page (no agent) shows neither.
const OWN = new Set<string>(['zumibot', 'agent'])

export const listedServers = (l: Pick<Loadout, 'servers'>): LoadoutServer[] => l.servers.filter((s) => !OWN.has(s.source))
export const listedHooks = (l: Pick<Loadout, 'hooks'>): LoadoutHook[] => l.hooks.filter((h) => !OWN.has(h.source))

/** Which hook row an action is working on: its file and place, since two rows can share an event. */
export const hookKey = (h: Pick<LoadoutHook, 'source' | 'event' | 'at'>): string =>
  `hook:${h.source}:${h.event}:${h.at ? `${h.at.group}.${h.at.hook}` : '-'}`

/** A copy sorted by name, ignoring case; the list given is left as it is. */
export const sortByName = <T extends { name: string }>(rows: readonly T[]): T[] =>
  [...rows].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))

const EMPTY: Record<LoadoutSection, string> = {
  servers: 'No MCP servers load in this folder.',
  plugins: 'No plugins are installed.',
  skills: 'No skills load in this folder.',
  hooks: 'No hooks are set up for this folder.'
}

export const emptyText = (section: LoadoutSection): string => EMPTY[section]

/** Said by the folder picker (I3): a probe is a real `claude` start in that folder, with no model call. */
export const FOLDER_RUN_NOTE = 'Looking at a folder starts its MCP servers and runs its hooks, as a chat there would.'

/** A save that failed because the form's view is old (stale) or its server is gone (lost) can only work again from a fresh view. */
export const offersReload = (error: string | null): boolean => error === EXT_TEXT.stale || error === EXT_TEXT.addFailedLost

/** The same hook in a fresher loadout, by its file, event, matcher and command, at whatever place it is now; null when it is not editable there. */
export function findHookRow(
  hooks: readonly LoadoutHook[],
  wanted: Pick<LoadoutHook, 'source' | 'event' | 'matcher' | 'command'>
): LoadoutHook | null {
  return (
    hooks.find(
      (h) =>
        h.source === wanted.source &&
        h.event === wanted.event &&
        h.matcher === wanted.matcher &&
        h.command === wanted.command &&
        hookRow(h).editable
    ) ?? null
  )
}
