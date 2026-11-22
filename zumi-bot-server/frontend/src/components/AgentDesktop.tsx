import { useEffect, useState } from 'react'
import type { DesktopStatus } from '@zumibot/shared/desktop'
import { displayName, type AgentFields } from '@zumibot/shared/frontmatter'
import { api } from '../api'
import { errorMessage } from '../errors'
import { useConnected } from '../useConnected'
import { useDesktop } from '../useAgentDesktop'
import { ConfirmDialog } from './ConfirmDialog'

interface Props {
  /** The saved name: the server keys desktops by it, not by an unsaved rename in the form. */
  agentName: string
  /** null when the raw text does not parse: the switch is disabled then. */
  fields: AgentFields | null
  onFields(patch: Partial<AgentFields>): void
}

/** Agent Studio's computer use section: the opt-in switch, the live view and Clear desktop data. */
export function AgentDesktop({ agentName, fields, onFields }: Props) {
  const desktop = useDesktop()
  const [status, setStatus] = useState<DesktopStatus | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const isOn = fields?.computerUse === true
  // The server reads the saved file: its status says whether computer use is on there and what this server lacks.
  const connected = useConnected()
  useEffect(() => {
    if (!connected) return
    let alive = true
    const load = (): void => {
      api.desktops.status(agentName).then(
        (s) => {
          if (alive) setStatus(s)
        },
        () => {
          if (alive) setStatus(null)
        }
      )
    }
    load()
    const off = api.agents.onChanged(load)
    return () => {
      alive = false
      off()
    }
  }, [agentName, connected])
  const savedOn = status !== null && status.state !== 'off'
  const missing = status?.state === 'unavailable' ? (status.missing ?? []) : null
  return (
    <div className="browser-settings desktop-settings" data-testid="desktop-settings">
      <div>
        <strong>Computer use</strong>
        <p>This agent gets its own desktop on this server and asks before every click, key or launch.</p>
        {missing && (
          <p className="desktop-missing" role="status">
            Desktop unavailable on this server{missing.length ? ` (missing: ${missing.join(', ')})` : ''}
          </p>
        )}
        {isOn && !savedOn && status !== null && <p>Save the agent to turn it on.</p>}
      </div>
      <button
        type="button"
        role="switch"
        className="rt-switch"
        data-testid="computer-use-switch"
        aria-checked={isOn}
        aria-label="Computer use"
        disabled={fields === null}
        // Off removes the key: absent is off, so the file never says `computerUse: false`.
        onClick={() => onFields({ computerUse: isOn ? null : true })}
      >
        <span className="rt-switch-dot" />
        <span className="rt-switch-text">{isOn ? 'On' : 'Off'}</span>
      </button>
      <button
        type="button"
        className="btn small"
        data-testid="open-desktop"
        disabled={!desktop || !savedOn || clearing}
        onClick={() => desktop?.open({ agent: agentName })}
      >
        Open Desktop
      </button>
      <button type="button" className="btn small danger-outline" disabled={clearing} onClick={() => setConfirmClear(true)}>
        {clearing ? 'Clearing…' : 'Clear desktop data'}
      </button>
      {notice && <p role="status">{notice}</p>}
      {confirmClear && (
        <ConfirmDialog
          title="Clear desktop data?"
          message={`This stops ${displayName(agentName)}’s desktop and deletes its desktop home folder (apps’ settings and sign-ins) on this server.`}
          buttons={[
            { label: 'Cancel', value: 'cancel' },
            { label: 'Clear desktop data', value: 'clear', danger: true }
          ]}
          onResolve={(choice) => {
            setConfirmClear(false)
            if (choice !== 'clear') return
            setClearing(true)
            setNotice(null)
            api.desktops
              .clear(agentName)
              .then(
                () => {
                  desktop?.forget(agentName)
                  setNotice('Desktop data cleared.')
                },
                (e) => setNotice(errorMessage(e))
              )
              .finally(() => setClearing(false))
          }}
        />
      )}
    </div>
  )
}
