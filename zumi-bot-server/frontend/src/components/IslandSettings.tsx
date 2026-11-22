import { useEffect, useState } from 'react'
import { ISLAND_AGENTS_MAX, type IslandSettings as IslandPrefs } from '@zumibot/shared/island'
import { displayName } from '@zumibot/shared/frontmatter'
import type { AgentSummary } from '@zumibot/shared/types'
import { api } from '../api'
import { errorMessage } from '../errors'
import { hotkeyFromKey, livePicks, movePick, pickRows, togglePick } from '../state/islandSettings'

/** The island's agents and Start at login. Each change goes to the shell alone and shows what it saved; the shell owns the data. */
export function IslandSettings({ agents }: { agents: AgentSummary[] }) {
  const island = api.desktop?.island
  const [saved, setSaved] = useState<IslandPrefs | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The voice shortcut: waiting for the keys, and the last choice another app already holds.
  const [recording, setRecording] = useState(false)
  const [taken, setTaken] = useState(false)

  useEffect(() => {
    island?.get().then(setSaved, (e) => setError(errorMessage(e)))
  }, [island])

  if (!island) return null

  const apply = async (patch: Partial<IslandPrefs>): Promise<void> => {
    setBusy(true)
    setError(null)
    setTaken(false)
    try {
      const next = await island.set(patch)
      setSaved(next)
      setTaken(next.ok === false) // the shell kept the old shortcut
    } catch (e) {
      // The last saved state stays on screen.
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const picks = livePicks(saved?.agents ?? [], agents)
  const locked = saved === null || busy
  return (
    <div data-testid="settings-island">
      <p className="set-intro">
        A small strip on the right edge of your screen shows the agents you pick, and opens a compact chat with one. It stays in the tray,
        and ZumiBot can start with your computer.
      </p>
      <div className="set-card">
        <label className="set-row">
          <span className="set-text">
            <span className="set-label">Start at login</span>
            <span className="set-hint">ZumiBot opens in the tray when you sign in, without a window.</span>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            data-testid="island-start-at-login"
            checked={saved?.startAtLogin === true}
            disabled={locked}
            onChange={(e) => void apply({ startAtLogin: e.target.checked })}
          />
        </label>
      </div>

      {saved?.voiceHotkey !== undefined && (
        <div className="set-card">
          <div className="set-row">
            <span className="set-text">
              <span className="set-label">Voice shortcut</span>
              <span className="set-hint">
                Press it anywhere to talk with an agent in the island, even with none picked. Press it again to stop.
              </span>
            </span>
            <span className="set-actions">
              <button
                type="button"
                className="btn small"
                data-testid="island-hotkey"
                aria-label="Voice shortcut"
                disabled={locked}
                onClick={() => setRecording(true)}
                onBlur={() => setRecording(false)}
                onKeyDown={(e) => {
                  if (!recording) return
                  e.preventDefault()
                  if (e.key === 'Escape') {
                    setRecording(false)
                    return
                  }
                  const acc = hotkeyFromKey(e)
                  if (acc === null) return
                  setRecording(false)
                  void apply({ voiceHotkey: acc })
                }}
              >
                {recording ? 'Press the keys…' : (saved.voiceHotkey ?? 'Off')}
              </button>
              {saved.voiceHotkey !== null && (
                <button
                  type="button"
                  className="btn small"
                  data-testid="island-hotkey-off"
                  disabled={locked}
                  onClick={() => void apply({ voiceHotkey: null })}
                >
                  Turn off
                </button>
              )}
            </span>
          </div>
          {taken && (
            <p className="set-note bad set-block" role="alert" data-testid="island-hotkey-taken">
              That shortcut is taken by another app.
            </p>
          )}
        </div>
      )}

      <h2 className="set-group">Agents on the island</h2>
      <div className="set-card" role="group" aria-label="Agents on the island">
        {saved !== null && agents.length === 0 && <p className="set-block set-hint">There are no agents to pick yet.</p>}
        {saved !== null &&
          pickRows(picks, agents).map((row) => {
            const name = row.agent.name
            return (
              <div key={name} className="set-row" data-testid="island-pick" data-agent-name={name}>
                <label className="island-pick-label">
                  <input
                    type="checkbox"
                    checked={row.picked}
                    disabled={locked || row.disabled}
                    onChange={() => void apply({ agents: togglePick(picks, name) })}
                  />
                  <span className="set-text">
                    <span className="set-label">{displayName(name)}</span>
                    {!row.picked && row.agent.error !== null && <span className="set-hint">Can’t be added: its file has a problem.</span>}
                  </span>
                </label>
                {row.picked && row.index !== null && (
                  <span className="set-actions">
                    <button
                      type="button"
                      className="btn small"
                      aria-label={`Move ${displayName(name)} up`}
                      disabled={locked || row.index === 0}
                      onClick={() => void apply({ agents: movePick(picks, name, -1) })}
                    >
                      Move up
                    </button>
                    <button
                      type="button"
                      className="btn small"
                      aria-label={`Move ${displayName(name)} down`}
                      disabled={locked || row.index === picks.length - 1}
                      onClick={() => void apply({ agents: movePick(picks, name, 1) })}
                    >
                      Move down
                    </button>
                  </span>
                )}
              </div>
            )
          })}
      </div>
      <p className="set-foot" data-testid="island-hint">
        {picks.length === 0 ? 'With none picked there is no island.' : `Up to ${ISLAND_AGENTS_MAX} agents, in this order from the top.`}
      </p>
      {error && (
        <p className="set-note bad" role="alert" data-testid="island-error">
          {error}
        </p>
      )}
    </div>
  )
}
