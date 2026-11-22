import { mergeAgents, type NotifyPayload } from '@zumibot/shared/notify'

// Only room replies pile up names ("writer, news replied"). Errors and the rest share the chat's tag
// but are about one agent, so a stale name from another kind must not leak into their text.
export function agentsFor(prev: { kind?: unknown; agents?: unknown } | null | undefined, payload: NotifyPayload): string[] {
  const names =
    payload.kind === 'replied' && prev?.kind === 'replied' && Array.isArray(prev.agents)
      ? prev.agents.filter((x): x is string => typeof x === 'string')
      : []
  return mergeAgents(names, payload.agent)
}
