import { CONNECTOR_IDS, connectorOf } from '@zumibot/shared/connectors'
import type { ConnectorId } from '@zumibot/shared/connectors'
import type { LoadoutServer } from '@zumibot/shared/extensions'

export interface MigratingAgent {
  name: string
  serversOff: readonly string[]
  /** The agent's own servers that have a URL (null for a command server). */
  own: ReadonlyArray<{ name: string; url: string | null }>
}

/**
 * The first-start switch-over: each agent keeps the catalog connectors it can use today, so nothing it relies on stops. An agent with
 * none is left out. A connector turned off in Claude Code (`disabled`) is not in use today and is skipped, or it would come alive later
 * without a Connectors decision; one that only needs signing in (needs-auth, failed) is still the user's connection and is kept.
 */
export function keptSwitches(
  servers: ReadonlyArray<Pick<LoadoutServer, 'name' | 'connector' | 'status'>>,
  agents: readonly MigratingAgent[]
): Record<string, ConnectorId[]> {
  const out: Record<string, ConnectorId[]> = {}
  for (const a of agents) {
    const kept = new Set<ConnectorId>()
    for (const s of servers) if (s.connector !== null && s.status !== 'disabled' && !a.serversOff.includes(s.name)) kept.add(s.connector)
    for (const o of a.own) {
      const id = connectorOf(o.url, o.name)
      if (id !== null) kept.add(id)
    }
    const ids = CONNECTOR_IDS.filter((id) => kept.has(id))
    if (ids.length) out[a.name] = ids
  }
  return out
}
