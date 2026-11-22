import { useCallback, useEffect, useRef, useState } from 'react'
import { CONNECTOR_TEXT } from '@zumibot/shared/connectors'
import type { ConnectorId, ConnectorsView } from '@zumibot/shared/connectors'
import type { AgentSummary } from '@zumibot/shared/types'
import { api } from '../api'
import { errorMessage } from '../errors'
import { cardModel, engineNotes, shouldRefresh, switchRows, withRemember, withSwitch } from '../state/connectors'
import type { SettingsSection } from '../state/route'
import { Switch } from './AgentLoadout'

/**
 * Settings › Connectors: the claude.ai connectors the CLI already loads, and one switch per Claude agent. The server's view is the
 * source of truth; a flip shows at once and a failure reloads it. Every sentence shown here is fixed text from the shared catalog,
 * the server's view or a rejected call.
 */
export function ConnectorsSettings({ agents, onSection }: { agents: AgentSummary[]; onSection: (section: SettingsSection) => void }) {
  const [view, setView] = useState<ConnectorsView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [flipping, setFlipping] = useState(false)
  const [copied, setCopied] = useState(false)
  const lastAt = useRef<number | null>(null)
  // An answer that lands after a newer request (or a flip's optimistic view) is dropped, so it cannot move a switch back.
  const gen = useRef(0)

  const load = useCallback(async (refresh: boolean): Promise<void> => {
    const g = ++gen.current
    lastAt.current = Date.now()
    try {
      const v = await api.connectors.list(refresh)
      if (g === gen.current) {
        setView(v)
        setError(null)
      }
    } catch (e) {
      if (g === gen.current) setError(errorMessage(e))
    }
  }, [])

  // The agent list is part of the view (a new or renamed agent gets a row), so it reloads with it.
  useEffect(() => {
    void load(false)
  }, [load, agents])

  useEffect(() => {
    const off = api.connectors.onChanged(() => void load(false))
    // Connecting happens on claude.ai: coming back to this tab re-reads the connectors.
    const back = (): void => {
      if (shouldRefresh(lastAt.current, Date.now())) void load(true)
    }
    const visible = (): void => {
      if (document.visibilityState === 'visible') back()
    }
    window.addEventListener('focus', back)
    document.addEventListener('visibilitychange', visible)
    return () => {
      off()
      window.removeEventListener('focus', back)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [load])

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])

  const flip = async (id: ConnectorId, agent: string, on: boolean): Promise<void> => {
    if (view === null) return
    gen.current++
    setFlipping(true)
    setError(null)
    setView(withSwitch(view, id, agent, on))
    try {
      await api.connectors.setAgent(id, agent, on)
    } catch (e) {
      await load(false)
      setError(errorMessage(e))
    } finally {
      setFlipping(false)
    }
  }

  const flipRemember = async (id: ConnectorId, on: boolean): Promise<void> => {
    if (view === null) return
    gen.current++
    setFlipping(true)
    setError(null)
    setView(withRemember(view, id, on))
    try {
      await api.connectors.setRemember(id, on)
    } catch (e) {
      await load(false)
      setError(errorMessage(e))
    } finally {
      setFlipping(false)
    }
  }

  const copy = (text: string): void => {
    navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => setCopied(false) // the clipboard can be denied; the URL stays on screen to select
    )
  }

  const shownError = error ?? view?.error ?? null

  return (
    <div data-testid="connectors-page">
      {view?.keyVar && (
        <p className="set-note bad" role="alert" data-testid="connector-keyvar">
          {CONNECTOR_TEXT.keyVar(view.keyVar)}
        </p>
      )}
      {view?.migration === 'running' && (
        <p className="set-note" role="status" data-testid="connector-migration">
          {CONNECTOR_TEXT.running}
        </p>
      )}
      {view?.migration === 'failed' && (
        <p className="set-note bad" role="alert" data-testid="connector-migration">
          {CONNECTOR_TEXT.migrationFailed}
        </p>
      )}
      {shownError !== null && (
        <p className="set-note bad" role="alert" data-testid="connector-error">
          {shownError}
        </p>
      )}

      <p className="set-intro">{CONNECTOR_TEXT.intro}</p>
      <p className="ext-note conn-note">{CONNECTOR_TEXT.machines}</p>
      {engineNotes(view).map((note) => (
        <p key={note} className="ext-note conn-note">
          {note}
        </p>
      ))}
      <p className="ext-note conn-note">{CONNECTOR_TEXT.zumiBot}</p>
      <p className="ext-note conn-note" data-testid="connector-guard-note">
        {CONNECTOR_TEXT.guardNote}
      </p>
      <p className="ext-note conn-note" data-testid="connector-cache-note">
        {CONNECTOR_TEXT.cacheNote}
      </p>

      {view === null ? (
        shownError === null && <p className="set-hint">Asking Claude Code…</p>
      ) : (
        <div className="conn-list">
          {view.connectors.map((card) => {
            const m = cardModel(card)
            const rows = switchRows(view, card.id)
            return (
              <section
                key={card.id}
                className="set-card"
                aria-label={m.name}
                data-testid="connector-card"
                data-id={card.id}
                data-state={card.state}
              >
                <div className="ext-row">
                  <div className="ext-row-main">
                    <span className="ext-dot" data-tone={m.tone} aria-hidden="true" />
                    <span className="set-label ext-name">{m.name}</span>
                    <span className="ext-status" data-tone={m.tone}>
                      {m.label}
                    </span>
                    <span className="grow" />
                    <a className="btn small" href={m.action.href} target="_blank" rel="noreferrer" data-testid="connector-action">
                      {m.action.label}
                    </a>
                  </div>
                  <p className="ext-note">{m.blurb}</p>
                  {m.hint && <p className="ext-note">{m.hint}</p>}
                  {m.unknownText && (
                    <p className="ext-note warn" data-testid="connector-unknown">
                      {m.unknownText}
                    </p>
                  )}
                  {m.customUrl && (
                    <div className="ext-row-sub">
                      <span>{CONNECTOR_TEXT.github}</span>
                      <code className="ext-code">{m.customUrl}</code>
                      <button type="button" className="btn small" data-testid="connector-copy" onClick={() => copy(m.customUrl!)}>
                        {copied ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                  )}
                  <p className="ext-note">{m.onText}</p>
                </div>
                <label className="set-row">
                  <span className="set-text">
                    <span className="set-label">{CONNECTOR_TEXT.rememberLabel}</span>
                    <span className="set-hint">{CONNECTOR_TEXT.rememberNote}</span>
                  </span>
                  <Switch
                    on={card.remember}
                    label={`${m.name}: ${CONNECTOR_TEXT.rememberLabel}`}
                    disabled={view.migration === 'running' || flipping}
                    onChange={(on) => void flipRemember(card.id, on)}
                    testId="connector-remember"
                    attrs={{ 'data-id': card.id, 'data-on': String(card.remember) }}
                  />
                </label>
                {rows.map((r) => (
                  <label key={r.agent} className="set-row">
                    <span className="set-text">
                      <span className="set-label">{r.agent}</span>
                    </span>
                    <Switch
                      on={r.on}
                      label={`${m.name} on for ${r.agent}`}
                      disabled={view.migration === 'running' || flipping}
                      onChange={(on) => void flip(card.id, r.agent, on)}
                      testId="connector-switch"
                      attrs={{ 'data-agent': r.agent, 'data-on': String(r.on) }}
                    />
                  </label>
                ))}
              </section>
            )
          })}
        </div>
      )}

      <p className="set-foot">
        <button type="button" className="ext-link" data-testid="connectors-to-claude-code" onClick={() => onSection('claude-code')}>
          {CONNECTOR_TEXT.toClaudeCode}
        </button>
      </p>
    </div>
  )
}
