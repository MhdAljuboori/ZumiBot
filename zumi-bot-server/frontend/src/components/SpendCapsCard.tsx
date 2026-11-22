import { useCallback, useEffect, useRef, useState } from 'react'
import { displayName } from '@zumibot/shared/agentName'
import type { AgentCapStatus } from '@zumibot/shared/spendCaps'
import type { AgentSummary } from '@zumibot/shared/types'
import { api } from '../api'
import { capBlockedOf, capRow } from '../state/spendCaps'
import { useConnected } from '../useConnected'

/** Settings › Usage › Spend caps: each agent's day under its daily cap, and Allow more today for one past it. */
export function SpendCapsCard({ agents }: { agents: readonly AgentSummary[] }) {
  const [caps, setCaps] = useState<AgentCapStatus[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  const load = useCallback(() => {
    const mine = ++seq.current // a slow older answer must not overwrite a newer one
    api.usage.caps().then(
      (c) => {
        if (mine === seq.current) setCaps(c)
      },
      () => {
        if (mine === seq.current) setCaps((c) => c ?? [])
      }
    )
  }, [])
  const connected = useConnected()
  useEffect(() => {
    if (connected) load()
  }, [connected, load])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = api.usage.onChanged(() => {
      clearTimeout(timer)
      timer = setTimeout(load, 500)
    })
    return () => {
      clearTimeout(timer)
      off()
    }
  }, [load])

  const allow = (agent: string): void => {
    setBusy(agent)
    setError(null)
    api.usage
      .allowMore(agent)
      .then(
        () => load(),
        (e: unknown) => setError(e instanceof Error ? e.message : 'Could not allow more')
      )
      .finally(() => setBusy(null))
  }

  if (caps === null) return null
  return (
    <section className="usg-caps" data-testid="usage-caps" aria-labelledby="usage-caps-title">
      <div className="usg-bd-head">
        <strong id="usage-caps-title">Spend caps</strong>
      </div>
      {caps.length === 0 ? (
        <p className="usg-note">
          No agent has a daily spend cap. Set one in Agent Studio; routines and workflows take a cap per run in their editors.
        </p>
      ) : (
        <ul className="usg-cap-list">
          {caps.map((c) => {
            const row = capRow(c)
            const blocked = capBlockedOf(c.agent, agents)
            // A cap on an agent whose engine reports no cost can never trip: the fixed sentence, not a live cap.
            if (blocked !== null) {
              return (
                <li key={c.agent} className="usg-cap" data-testid="usage-cap" data-agent={c.agent} data-blocked="true">
                  <div className="usg-cap-top">
                    <span className="usg-name">{displayName(c.agent)}</span>
                  </div>
                  <div className="usg-cap-foot">
                    <span className="usg-sub" data-testid="usage-cap-blocked">
                      {blocked} Remove it in Agent Studio.
                    </span>
                  </div>
                </li>
              )
            }
            return (
              <li
                key={c.agent}
                className={`usg-cap${row.over ? ' over' : ''}`}
                data-testid="usage-cap"
                data-agent={c.agent}
                data-over={row.over}
              >
                <div className="usg-cap-top">
                  <span className="usg-name">{displayName(c.agent)}</span>
                  <span className="usg-cap-line">{row.line}</span>
                </div>
                <div
                  className="usg-cap-bar"
                  role="progressbar"
                  aria-label={`${displayName(c.agent)}: ${row.line}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(row.pct)}
                >
                  <i style={{ width: `${row.pct}%` }} />
                </div>
                {(row.raised || row.over) && (
                  <div className="usg-cap-foot">
                    {row.raised && <span className="usg-sub">{row.raised}</span>}
                    {row.over && <span className="usg-sub">Over its cap: its routines and workflow steps wait.</span>}
                    {row.over && (
                      <button
                        type="button"
                        className="btn small"
                        data-testid="usage-cap-allow"
                        disabled={busy === c.agent}
                        onClick={() => allow(c.agent)}
                      >
                        {row.action}
                      </button>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {error && (
        <div className="usg-error" role="alert">
          {error}
        </div>
      )}
    </section>
  )
}
