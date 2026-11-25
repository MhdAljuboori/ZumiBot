import { useCallback, useEffect, useRef, useState } from 'react'
import type { EngineCommands } from '@zumibot/shared/engineCommands'
import { api } from '../api'
import { useOnReconnect } from '../useConnected'

/**
 * The agent engine's own `/` rows (Claude Code commands or Codex skills) for `agent` in `folder` (null: a scratch folder, which
 * the server maps to home). Fetched when either changes, again after a reconnect, and on `extensions:changed` and `agents:changed`
 * (a skill, plugin or the agent's own file changed; the server dropped its cache). Null while loading, on an error (the menu
 * then just has no engine rows), and for no agent. Another agent or folder starts from nothing, and an answer for an older one
 * is dropped.
 */
export function useEngineCommands(agent: string | null, folder: string | null): EngineCommands | null {
  // Kept with its key, so the render right after a switch (before the effect clears it) never shows the old agent's rows.
  const [held, setHeld] = useState<{ agent: string; folder: string | null; commands: EngineCommands | null } | null>(null)
  const keyRef = useRef({ agent, folder })
  keyRef.current = { agent, folder }
  // Bumped per request and on every key change, so only the latest request may show.
  const latest = useRef(0)

  const load = useCallback((): void => {
    const { agent: a, folder: f } = keyRef.current
    if (a === null) return
    const mine = ++latest.current
    api.agents.engineCommands(a, f).then(
      (answer) => {
        if (latest.current === mine) setHeld({ agent: a, folder: f, commands: answer })
      },
      () => {
        // Keeps what shows: the next fetch replaces it, and a failed refetch must not empty a working menu.
      }
    )
  }, [])

  useEffect(() => {
    latest.current++
    setHeld(null)
    load()
    // An open chat's list follows a change made anywhere; a refetch keeps the shown list until its answer lands.
    const offExt = api.extensions.onChanged(load)
    const offAgents = api.agents.onChanged(load)
    return () => {
      latest.current++
      offExt()
      offAgents()
    }
  }, [agent, folder, load])

  useOnReconnect(load)
  return held && held.agent === agent && held.folder === folder ? held.commands : null
}
