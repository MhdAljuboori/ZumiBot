// Pure types, names and sentences for the Servers / Plugins / Skills / Hooks page and the per-agent settings, shared by the server and the UI: no `node:` imports.
import type { Engine } from './engine'
import type { ConnectorId } from './connectors' // type-only: connectors.ts imports values from here, so this edge must stay erased

// ---- What an agent file holds (ZumiBot-only keys and the CLI's subagent keys) ----

export type McpTransport = 'stdio' | 'http' | 'sse'

export interface McpServerDef {
  type?: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

export interface HookCommand {
  type: 'command'
  command: string
  timeout?: number
}

export interface HookGroup {
  matcher?: string
  hooks: Array<HookCommand | Record<string, unknown>>
}

export type HooksConfig = Record<string, HookGroup[]>

/** One `mcpServers` entry of an agent file; a null `def` is a bare reference to a server that is already configured. */
export interface AgentOwnServer {
  name: string
  def: McpServerDef | null
}

export interface AgentExtensions {
  serversOff: string[]
  skillsOff: string[]
  plugins: Record<string, boolean>
  servers: AgentOwnServer[]
  serversEditable: boolean
  hooks: HooksConfig
  hooksEditable: boolean
}

export const NO_EXTENSIONS: AgentExtensions = {
  serversOff: [],
  skillsOff: [],
  plugins: {},
  servers: [],
  serversEditable: true,
  hooks: {},
  hooksEditable: true
}

/** The CLI's tool prefix for a server (`mcp__<name>`); every character outside the set becomes `_`, so `claude.ai Gmail` is `mcp__claude_ai_Gmail`. */
export function toolPrefix(serverName: string): string {
  return 'mcp__' + serverName.replace(/[^A-Za-z0-9_-]/g, '_')
}

/**
 * ZumiBot's own bridges are `zumibot_*`. Judged after the CLI's own normalizing, since `zumibot.browser` would otherwise
 * share the `mcp__zumibot_browser__` tool prefix with the real bridge. The run (agentRunConfig), the RPCs and the forms use this one rule.
 */
export function isReservedServerName(name: string): boolean {
  return toolPrefix(name).startsWith('mcp__zumibot_')
}

/** The characters the CLI's own server names use (`claude.ai Gmail`, `plugin:x:y`). */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_.:@ -]{1,100}$/

// Names that are Object prototype keys: a plain object read or write of one is not a server.
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** A server name the page may write or name; a leading `-` is refused, since `claude mcp` would read it as a flag. */
export function isServerName(name: string): boolean {
  return SERVER_NAME_PATTERN.test(name) && !name.startsWith('-') && !PROTO_KEYS.has(name)
}

const isPlain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const isText = (v: unknown): v is string => typeof v === 'string'

// fromEntries makes own properties, so a `__proto__` key survives where plain assignment would drop it.
function textMap(v: unknown): Record<string, string> | null {
  if (!isPlain(v)) return null
  const entries = Object.entries(v)
  return entries.every(([, x]) => isText(x)) ? (Object.fromEntries(entries) as Record<string, string>) : null
}

const MCP_KEYS = new Set(['type', 'command', 'args', 'env', 'url', 'headers'])

/** One server definition in the CLI's format; null for anything outside it, so an unknown shape is kept in the file and never applied. */
export function parseMcpDef(v: unknown): McpServerDef | null {
  if (!isPlain(v)) return null
  if (Object.keys(v).some((k) => !MCP_KEYS.has(k))) return null
  const def: McpServerDef = {}
  if (v.type !== undefined) {
    if (v.type !== 'stdio' && v.type !== 'http' && v.type !== 'sse') return null
    def.type = v.type
  }
  if (v.command !== undefined) {
    if (!isText(v.command)) return null
    def.command = v.command
  }
  if (v.args !== undefined) {
    if (!Array.isArray(v.args) || !v.args.every(isText)) return null
    def.args = [...v.args]
  }
  if (v.env !== undefined) {
    const env = textMap(v.env)
    if (!env) return null
    def.env = env
  }
  if (v.url !== undefined) {
    if (!isText(v.url)) return null
    def.url = v.url
  }
  if (v.headers !== undefined) {
    const headers = textMap(v.headers)
    if (!headers) return null
    def.headers = headers
  }
  return def.command === undefined && def.url === undefined ? null : def
}

/**
 * A hook timeout the CLI keeps (Ruling 23): claude 2.1.322 silently drops a run's WHOLE merged `--settings` (the pause hook, the vault
 * guard, the ask rules, the side guard) for one PreToolUse hook timed 0 or below, and drops such a hook of another event alone, so
 * anything else makes a block "kept in the file, not applied".
 */
export const isHookTimeout = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0

const isEditableHook = (h: Record<string, unknown>) =>
  Object.keys(h).every((k) => k === 'type' || k === 'command' || k === 'timeout') &&
  h.type === 'command' &&
  isText(h.command) &&
  (h.timeout === undefined || isHookTimeout(h.timeout))

/**
 * A `hooks` block in settings.json format. `editable` is false when the editor could not write it back without losing
 * something (a `prompt` hook, an extra key), and `config` then holds only the groups and hooks that are objects.
 */
export function parseHooks(v: unknown): { config: HooksConfig; editable: boolean } | null {
  if (!isPlain(v) || !Object.values(v).every(Array.isArray)) return null
  let editable = true
  const config: HooksConfig = {}
  for (const [event, groups] of Object.entries(v) as Array<[string, unknown[]]>) {
    const kept: HookGroup[] = []
    for (const g of groups) {
      if (!isPlain(g)) {
        editable = false
        continue
      }
      const hooks = Array.isArray(g.hooks) ? g.hooks.filter(isPlain) : []
      if (!Array.isArray(g.hooks) || hooks.length !== g.hooks.length || !hooks.every(isEditableHook)) editable = false
      if (Object.keys(g).some((k) => k !== 'matcher' && k !== 'hooks') || (g.matcher !== undefined && !isText(g.matcher))) editable = false
      kept.push({ ...g, hooks } as HookGroup)
    }
    // An own property again, for an event named `__proto__`.
    Object.defineProperty(config, event, { value: kept, enumerable: true, writable: true, configurable: true })
  }
  return { config, editable }
}

/** `${vault:<ENV_NAME>}` in an own server's env or header value: the env name of a Vault API key granted to the agent. */
export const VAULT_REF_PATTERN = /\$\{vault:([A-Za-z_][A-Za-z0-9_]*)\}/g

/** Env names the def references, env values first, then headers, each once in order of first appearance. */
export function vaultRefs(def: McpServerDef): string[] {
  const seen = new Set<string>()
  for (const values of [def.env, def.headers])
    for (const value of Object.values(values ?? {}))
      // A fresh regex: the exported one is global, and its lastIndex is shared state.
      for (const m of value.matchAll(new RegExp(VAULT_REF_PATTERN))) seen.add(m[1])
  return [...seen]
}

// ---- What the page shows (a CLI probe's answer, cut down to what is safe to send) ----

export type McpScope = 'user' | 'local' | 'project'
export type ServerStatus = 'connected' | 'needs-auth' | 'failed' | 'pending' | 'disabled' | 'unknown'
export type ServerSource = 'user' | 'local' | 'project' | 'plugin' | 'claudeai' | 'agent' | 'zumibot' | 'other'
export type SkillSource = 'user' | 'project' | 'plugin' | 'claudeai' | 'bundled' | 'other'
export type HookSource = 'user' | 'project' | 'local' | 'plugin' | 'agent' | 'zumibot' | 'other'
export type LoadoutSection = 'servers' | 'plugins' | 'skills' | 'hooks'

export interface LoadoutServer {
  name: string
  status: ServerStatus
  source: ServerSource
  transport: string | null
  plugin: string | null
  tools: string[]
  scope: McpScope | null
  note: string | null
  /** The catalog connector this server is, derived in the sanitizer from its URL or name (the URL itself never leaves it). */
  connector: ConnectorId | null
}

export interface LoadoutPlugin {
  id: string
  enabled: boolean
  skills: number
  servers: number
  hooks: number
}

export interface LoadoutSkill {
  name: string
  description: string
  source: SkillSource
  plugin: string | null
  tokens: number | null
  on: boolean
  editable: boolean
}

export interface LoadoutHook {
  event: string
  matcher: string
  type: string
  command: string
  timeout: number | null
  source: HookSource
  plugin: string | null
  // Where it sits in its settings file (null when this page cannot edit it) and the file's stamp for the stale check.
  at: { group: number; hook: number } | null
  stamp: string | null
}

export interface Loadout {
  engine: Engine
  version: string | null
  folder: string
  agent: string | null
  servers: LoadoutServer[]
  plugins: LoadoutPlugin[]
  skills: LoadoutSkill[]
  hooks: LoadoutHook[]
  // A section the CLI could not report: its fixed sentence; the others still show.
  errors: Partial<Record<LoadoutSection, string>>
  at: number
}

/** A server the page can edit, read back from its scope's file. Hidden names keep an empty value: the page never gets one. */
export interface McpServerView {
  name: string
  scope: McpScope
  def: McpServerDef
  hidden: { env: string[]; headers: string[] }
  stamp: string
}

/** What the form saves: a null env or header value keeps the stored one. */
export type McpServerInput = Omit<McpServerDef, 'env' | 'headers'> & {
  env?: Record<string, string | null>
  headers?: Record<string, string | null>
}

export interface SkillView {
  scope: 'user' | 'project'
  name: string
  description: string
  body: string
  files: string[]
  stamp: string
}

export type HookFile = 'user' | 'project' | 'local'

/** A hook's place in its settings file: `hooks.<Event>[group].hooks[hook]`. */
export interface HookPosition {
  group: number
  hook: number
}

/** A command hook the page adds, or with `at` edits in place. */
export interface HookInput {
  event: string
  matcher: string
  command: string
  timeout?: number
  at?: HookPosition
}

const SECTION_NAMES: Record<LoadoutSection, string> = { servers: 'MCP servers', plugins: 'plugins', skills: 'skills', hooks: 'hooks' }

/** Every sentence an error or a note on this page may show; CLI output and file contents never reach the page. */
export const EXT_TEXT = {
  stale: 'This changed on disk since you opened it. Reload it and try again.',
  badJson: (file: string) => `${file} is not valid JSON, so it was left unchanged.`,
  notFound: 'That item was not found.',
  unsupported: (section: LoadoutSection) => `This Claude Code version does not report ${SECTION_NAMES[section]}.`,
  cliMissing: 'Claude Code was not found on this machine.',
  timeout: 'Claude Code did not answer in time.',
  // A Codex agent's card is read from `codex app-server`: its sentences name Codex.
  codexMissing: 'Codex was not found on this machine.',
  codexTimeout: 'Codex did not answer in time.',
  codexUnsupported: (section: LoadoutSection) => `This Codex version does not report ${SECTION_NAMES[section]}.`,
  // An ACP agent gets no probe: its servers, plugins, skills and hooks are its own, from its own configuration.
  acpUnsupported:
    'An ACP agent keeps its own servers, plugins, skills and hooks in its own configuration. ZumiBot does not read or change them.',
  // A remote agent gets no probe either: whatever it runs is on its server.
  aguiUnsupported: 'A remote agent keeps its own servers, plugins, skills and hooks on its server. ZumiBot does not read or change them.',
  badName: 'A name may hold only letters, digits, spaces and . : @ _ - and be at most 100 characters.',
  reservedName: 'Names starting with zumibot_ are reserved for ZumiBot.',
  vaultMissing: (env: string) => `Not started: no Vault key ${env} is granted to this agent.`,
  vaultLocked: 'Not started: the Vault key is missing or does not match, so its keys are not available.',
  addFailedRestored: 'The server could not be saved, so the previous one was put back.',
  // Shown on an edit form, whose Reload opens the server as a new one once it is gone.
  addFailedLost:
    'The server could not be saved, and the previous one could not be put back, so it is no longer set up. Reload to add it again.',
  badServer: 'That is not a server definition Claude Code takes: it needs a command or a URL, and only text values.',
  badSkillName: 'A skill name may hold only lower-case letters, digits and single hyphens, and be at most 100 characters.',
  badFolder: 'Pick a folder that exists on this machine.',
  nameTaken: 'That name is already taken here.',
  cliFailed: 'Claude Code could not make that change.',
  notEditable: 'This cannot be edited here.',
  machineOnly: 'Changes here apply to this machine only; sync does not copy them.',
  /** An agent's own server whose name a configured server also has: the agent's replaces it in the run. */
  sameName: 'Same name as a server this agent already loads.',
  /** A project server the CLI read from a parent folder's file: the chosen folder's `.mcp.json` does not hold it. */
  fromParentMcp: (folder: string) => `From ${folder}'s .mcp.json`,
  /** A project file that is a link, or lies outside the folder (Ruling 25): shown, never written. */
  linkedFile: 'Its file is a link or lies outside this folder, so it is not edited here.'
}
