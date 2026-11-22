import {
  askRules,
  CONNECTOR_IDS,
  connectorOf,
  connectorPrefixes,
  denyEntries,
  type ConnectorId,
  type ConnectorServerName
} from '@zumibot/shared/connectors'
import {
  isHookTimeout,
  isReservedServerName,
  NO_EXTENSIONS,
  toolPrefix,
  vaultRefs,
  VAULT_REF_PATTERN,
  type AgentExtensions,
  type McpServerDef
} from '@zumibot/shared/extensions'
import type { VaultItem } from '@zumibot/shared/vault'
import { vaultEnvOf } from '../vault/vaultEnv'

export interface AgentRunConfig {
  /** The belt: one `mcp__<server>` deny rule per server the agent has off, for a CLI that stops honouring `deniedMcpServers`. */
  disallowedTools: string[]
  /** At most `--settings <json>` then `--mcp-config <json>`; no Vault value is ever in here. */
  extraArgs: string[]
  /** `ZUMIBOT_MCP_VAULT_<n>` -> the key's value, for the CLI to expand when it starts the server. */
  env: Record<string, string>
  /** An own server left out of the run, and why; the agent file is never changed. */
  dropped: Array<{ server: string; env: string | null; reason: 'vault-missing' | 'vault-locked' | 'reserved-name' }>
  /** Tool prefix -> catalog connector, for the permission step; `{}` when the caller gave no `connectorsOff` (the probe). */
  connectorPrefixes: Readonly<Record<string, ConnectorId>>
  /** The catalog connectors this run denies (the caller's `connectorsOff`; `[]` without one): the permission step refuses their calls too. */
  connectorsOff: readonly ConnectorId[]
}

function deepFreeze<T extends object>(v: T): T {
  for (const x of Object.values(v)) if (x !== null && typeof x === 'object') deepFreeze(x)
  return Object.freeze(v)
}

/** The shared "nothing to add" value: frozen, so no consumer can change what every other agent starts from. */
export const NO_RUN_CONFIG: AgentRunConfig = deepFreeze({
  disallowedTools: [],
  extraArgs: [],
  env: {},
  dropped: [],
  connectorPrefixes: {},
  connectorsOff: []
})

// The belt for Ruling 23: on claude 2.1.322 one PreToolUse hook with a timeout of 0 or below drops the run's whole merged --settings,
// guards included (another event's is dropped alone, silently), so no such hook leaves here, even from a caller that calls its block
// editable. A group or event left empty goes too.
const keepsSettings = (h: { timeout?: unknown }): boolean => h.timeout === undefined || isHookTimeout(h.timeout)

/** A definition with each Vault reference in its env and header values turned into the env var the CLI will expand. */
function rewritten(def: McpServerDef, varOf: (envName: string) => string): McpServerDef {
  const fill = (text: string) => text.replace(VAULT_REF_PATTERN, (_all, envName: string) => '${' + varOf(envName) + '}')
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(def)) {
    // Only env and headers are searched for references; everything else is the CLI's, passed as written.
    if ((k === 'env' || k === 'headers') && v)
      out[k] = Object.fromEntries(Object.entries(v as Record<string, string>).map(([name, text]) => [name, fill(text)]))
    else out[k] = JSON.parse(JSON.stringify(v))
  }
  return out as McpServerDef
}

/**
 * What one run of an agent needs for its saved extension choices. Pure: the same inputs give the same answer in a main
 * run, a side run, a Compact and the probe, so the server set and the cache prefix match in all of them. `keys` are the
 * agent's granted Vault items, or 'locked' when the Vault cannot be opened. `connectorsOff` are the catalog connectors not on
 * for the agent: denied after its own off list by the same `deniedMcpServers` and belt; the ones that are on get `permissions.ask` globs
 * (so the CLI asks ZumiBot even in auto mode) and a prefix map for the permission step, over the names `connectorServers` learned
 * plus the agent's own servers that are catalog connectors. `serversOff: false` and `skillsOff: false`
 * (the probe passes both, each independent of the other) leave the deny list and the skill overrides out, so a server or
 * a skill the agent turned off still shows up and can be switched back on.
 */
export function buildAgentRunConfig(
  ext: AgentExtensions,
  keys: readonly VaultItem[] | 'locked',
  opts: {
    serversOff?: boolean
    skillsOff?: boolean
    connectorsOff?: readonly ConnectorId[]
    connectorServers?: readonly ConnectorServerName[]
  } = {}
): AgentRunConfig {
  const settings: Record<string, unknown> = {}
  let disallowedTools: string[] = []

  if (opts.serversOff !== false) {
    // ZumiBot's bridges are always on (the card says so): a hand-edited file naming one denies nothing.
    const names = [...new Set(ext.serversOff)].filter((name) => !isReservedServerName(name))
    // Connectors come after the agent's own list; the belt is deduped as a whole (a name may be in both).
    const connectors = denyEntries(opts.connectorsOff ?? [])
    const denied = [...names.map((serverName) => ({ serverName })), ...connectors.deniedMcpServers]
    if (denied.length > 0) {
      settings.deniedMcpServers = denied
      disallowedTools = [...new Set([...names.map(toolPrefix), ...connectors.disallowedTools])]
    }
  }
  if (Object.keys(ext.plugins).length > 0) settings.enabledPlugins = ext.plugins
  if (opts.skillsOff !== false && ext.skillsOff.length > 0)
    settings.skillOverrides = Object.fromEntries(ext.skillsOff.map((name) => [name, 'off']))
  // A block the editor could not read whole may hold what it does not understand (a `prompt` hook): none of it is applied.
  if (ext.hooksEditable) {
    const hooks = Object.fromEntries(
      Object.entries(ext.hooks).flatMap(([event, groups]) => {
        const kept = groups.flatMap((g) => {
          const list = g.hooks.filter(keepsSettings)
          return list.length > 0 ? [list.length === g.hooks.length ? g : { ...g, hooks: list }] : []
        })
        return kept.length > 0 ? [[event, kept]] : []
      })
    )
    if (Object.keys(hooks).length > 0) settings.hooks = hooks
  }

  const granted = keys === 'locked' ? new Map<string, string>() : new Map(Object.entries(vaultEnvOf(keys).env))
  const dropped: AgentRunConfig['dropped'] = []
  // One winner per name, resolved before any check, so `dropped` and the config can never disagree: the last definition
  // wins at the first one's place (as duplicate keys in the object the CLI reads). A bare reference takes part too.
  const winners = new Map<string, McpServerDef | null>()
  // A list the parser could not read whole is kept in the file and not applied, like the hooks above.
  if (ext.serversEditable) for (const { name, def } of ext.servers) winners.set(name, def)
  const kept = new Map<string, McpServerDef>()
  for (const [name, def] of winners) {
    if (def === null) continue
    // The same rule the RPCs refuse a name by, so a name never saves and is then dropped at run time.
    if (isReservedServerName(name)) {
      dropped.push({ server: name, env: null, reason: 'reserved-name' })
      continue
    }
    const refs = vaultRefs(def)
    if (refs.length > 0 && keys === 'locked') {
      dropped.push({ server: name, env: refs[0], reason: 'vault-locked' })
      continue
    }
    const missing = refs.find((r) => !granted.has(r))
    if (missing !== undefined) {
      dropped.push({ server: name, env: missing, reason: 'vault-missing' })
      continue
    }
    kept.set(name, def)
  }

  const numbers = new Map<string, number>()
  const env: Record<string, string> = {}
  const varOf = (envName: string): string => {
    let n = numbers.get(envName)
    if (n === undefined) {
      n = numbers.size
      numbers.set(envName, n)
      env[`ZUMIBOT_MCP_VAULT_${n}`] = granted.get(envName) as string
    }
    return `ZUMIBOT_MCP_VAULT_${n}`
  }
  const mcpServers = Object.fromEntries([...kept].map(([name, def]) => [name, rewritten(def, varOf)]))

  // Only with connectorsOff: the probe's call has no connector view. Only the own servers this run passes (`kept`) count, and only by
  // a catalog URL: a name alone never makes an own server a connector.
  let prefixes: Record<string, ConnectorId> = {}
  if (opts.connectorsOff !== undefined) {
    const byUrl = (def: McpServerDef): ConnectorId | null => (def.url === undefined ? null : connectorOf(def.url, ''))
    const own: ConnectorServerName[] = []
    for (const [name, def] of kept) {
      const connector = byUrl(def)
      if (connector !== null) own.push({ name, connector })
    }
    prefixes = connectorPrefixes([...(opts.connectorServers ?? []), ...own])
    // The CLI loads the agent's own definition under its name, so a catalog or learned name it redefines elsewhere is no connector
    // here: dropping the prefix keeps that server's tools from ever being taken for the connector's (reads would run with no card).
    for (const [name, def] of kept) {
      const p = toolPrefix(name)
      if (prefixes[p] !== undefined && prefixes[p] !== byUrl(def)) delete prefixes[p]
    }
    const off = opts.connectorsOff
    const rules =
      opts.serversOff !== false
        ? askRules(
            CONNECTOR_IDS.filter((id) => !off.includes(id)),
            prefixes
          )
        : []
    if (rules.length > 0) settings.permissions = { ask: rules }
  }

  const extraArgs: string[] = []
  if (Object.keys(settings).length > 0) extraArgs.push('--settings', JSON.stringify(settings))
  if (kept.size > 0) extraArgs.push('--mcp-config', JSON.stringify({ mcpServers }))
  return { disallowedTools, extraArgs, env, dropped, connectorPrefixes: prefixes, connectorsOff: [...(opts.connectorsOff ?? [])] }
}

/**
 * What a run falls back to when the agent's config cannot be read: nothing of the agent's own, but every catalog connector denied. A
 * read that fails must not fail open, or every connected claude.ai connector would be live for that run. Frozen like NO_RUN_CONFIG.
 */
export const CONNECTORS_ALL_OFF: AgentRunConfig = deepFreeze(buildAgentRunConfig(NO_EXTENSIONS, [], { connectorsOff: CONNECTOR_IDS }))
