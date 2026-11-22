import { useEffect, useRef, useState } from 'react'
import type { AgentRule } from '@zumibot/shared/types'
import { api } from '../api'
import { errorMessage } from '../errors'
import { useOnReconnect } from '../useConnected'
import { ruleLabel } from '../state/approvals'

export function RememberedApprovals({ agentName }: { agentName: string }) {
  const [rules, setRules] = useState<AgentRule[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const latest = useRef(0) // an older response must not overwrite a newer one
  const alive = useRef(true)

  const load = (): void => {
    const n = ++latest.current
    api.approvals.list(agentName).then(
      (r) => {
        if (!alive.current || n !== latest.current) return
        setRules(r)
        setLoadFailed(false)
      },
      () => {
        if (alive.current && n === latest.current) setLoadFailed(true)
      }
    )
  }

  useEffect(() => {
    alive.current = true
    setRules(null)
    setLoadFailed(false)
    setRemoveError(null)
    load()
    const off = api.approvals.onChanged((name) => {
      if (name === agentName) load()
    })
    return () => {
      alive.current = false
      off()
    }
  }, [agentName])

  // A list the socket cut off, or a change pushed while it was down: read again once it is back.
  useOnReconnect(load)

  const remove = (key: string): void => {
    setRemoveError(null)
    api.approvals.remove(agentName, key).then(
      (r) => {
        if (!alive.current) return
        latest.current++
        setRules(r)
        setLoadFailed(false)
      },
      (e) => {
        if (!alive.current) return
        setRemoveError(errorMessage(e))
        load() // keep the list accurate after a failed removal
      }
    )
  }

  if (rules === null && !loadFailed) return null
  return (
    <section className="remembered" aria-label="Remembered approvals">
      <h3 className="card-title">Remembered approvals</h3>
      {removeError && (
        <div className="field-error" role="alert">
          Could not remove the approval: {removeError}
        </div>
      )}
      {loadFailed && rules === null ? (
        <div className="field-error" role="alert">
          Could not load remembered approvals.
        </div>
      ) : rules !== null && rules.length === 0 ? (
        <div className="hint">No remembered approvals. Use &quot;Allow always for this agent&quot; on an approval card.</div>
      ) : (
        <>
          {loadFailed && (
            <div className="field-error" role="alert">
              Could not refresh remembered approvals; this list may be out of date.
            </div>
          )}
          <ul className="remembered-list">
            {rules?.map((r) => (
              <li key={r.key} className="remembered-row">
                <span className="remembered-label">{ruleLabel(r)}</span>
                <button
                  type="button"
                  className="btn ghost small"
                  data-testid="rule-remove"
                  aria-label={`Remove ${ruleLabel(r)}`}
                  onClick={() => remove(r.key)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
