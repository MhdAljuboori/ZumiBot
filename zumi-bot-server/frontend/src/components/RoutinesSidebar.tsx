import { useMemo, useState } from 'react'
import type { RoutinesSnapshot } from '@zumibot/shared/routines'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import { api } from '../api'
import { routineRows, type RoutineRow } from '../state/routinesList'
import { Glyph } from './Sidebar'

const ICON = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true
} as const

function TriggerIcon({ kind }: { kind: RoutineRow['icon'] }) {
  return (
    <svg className="glyph" {...ICON}>
      {kind === 'schedule' && (
        <>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 8v4l3 2" />
        </>
      )}
      {kind === 'webhook' && <path d="M13 3 5 14h6l-1 7 8-11h-6z" />}
      {kind === 'manual' && <path d="M8 5v14l11-7z" />}
    </svg>
  )
}

interface Props {
  open: boolean
  onClose: () => void
  snapshot: RoutinesSnapshot
  agents: AgentSummary[]
  chats: ChatMeta[]
  /** Epoch ms from the caller; the next-run text follows it. */
  now: number
  selectedId: string | null
  onNew: () => void
  onOpen: (id: string) => void
  onError: (e: unknown) => void
}

/** The Routines column, in the sidebar's place: each routine with its switch and last run's dot, as the Workflows column. */
export function RoutinesSidebar(p: Props) {
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [switching, setSwitching] = useState<ReadonlySet<string>>(new Set())
  const rows = useMemo(() => routineRows(p.snapshot, p.agents, p.chats, p.now, query), [p.snapshot, p.agents, p.chats, p.now, query])

  // Applies at once, like the workflow rows' switch; the push brings the new state (an open editor follows it).
  const toggle = (id: string, on: boolean): void => {
    setSwitching((s) => new Set(s).add(id))
    api.routines
      .setEnabled(id, on)
      .catch(p.onError)
      .finally(() =>
        setSwitching((s) => {
          const next = new Set(s)
          next.delete(id)
          return next
        })
      )
  }
  const closeSearch = (): void => {
    setSearching(false)
    setQuery('')
  }

  return (
    <aside className={p.open ? 'sidebar open' : 'sidebar'} id="sidebar" data-testid="routines-sidebar">
      <div className="sidebar-head">
        {searching ? (
          <div className="search">
            <Glyph name="search" />
            <input
              className="search-input"
              data-testid="routine-search-input"
              type="text"
              value={query}
              placeholder="Search routines"
              aria-label="Search routines"
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') closeSearch()
              }}
            />
            <button type="button" className="search-close" aria-label="Close search" onClick={closeSearch}>
              <Glyph name="close" />
            </button>
          </div>
        ) : (
          <>
            <h2 className="sidebar-title">Routines</h2>
            <span className="count-badge" aria-label={`${p.snapshot.routines.length} routines`}>
              {p.snapshot.routines.length}
            </span>
            <span className="grow" />
            <button
              type="button"
              className="head-btn"
              data-testid="new-routine"
              aria-label="New routine"
              data-tip="New routine"
              onClick={p.onNew}
            >
              <Glyph name="plus" />
            </button>
            <button
              type="button"
              className="head-btn"
              data-testid="routine-search-button"
              aria-label="Search routines"
              data-tip="Search routines"
              onClick={() => setSearching(true)}
            >
              <Glyph name="search" />
            </button>
          </>
        )}
        <button
          type="button"
          className="head-btn nav-close"
          data-testid="nav-close"
          aria-label="Close sidebar"
          data-tip="Close sidebar"
          onClick={p.onClose}
        >
          <Glyph name="close" />
        </button>
      </div>
      <nav className="agent-list routine-list" aria-label="Routines">
        {rows.map((r) => {
          const selected = r.id === p.selectedId
          return (
            <div key={r.id} className={selected ? 'wf-row selected' : 'wf-row'} data-enabled={r.enabled ? 'true' : 'false'}>
              <button
                type="button"
                className="routine-row"
                data-testid="routine-row"
                data-routine-id={r.id}
                data-dot={r.dot ?? ''}
                aria-current={selected ? 'page' : undefined}
                onClick={() => p.onOpen(r.id)}
              >
                <span className="routine-ic">
                  <TriggerIcon kind={r.icon} />
                </span>
                <span className="routine-text">
                  <span className="routine-name">
                    <span className="routine-name-text">{r.name}</span>
                    {r.dot && <span className={`routine-dot ${r.dot}`} aria-hidden="true" />}
                  </span>
                  <span className="routine-sub">{r.subline}</span>
                  {r.warning && <span className="routine-warn">{r.warning}</span>}
                </span>
              </button>
              <button
                type="button"
                role="switch"
                className="wf-row-switch"
                data-testid="routine-row-enabled"
                aria-checked={r.enabled}
                aria-label={`${r.name}: ${r.enabled ? 'on' : 'off'}`}
                data-tip={r.enabled ? 'On' : 'Off'}
                disabled={switching.has(r.id)}
                onClick={() => toggle(r.id, !r.enabled)}
              >
                <span className="wf-row-knob" />
              </button>
            </div>
          )
        })}
        {rows.length === 0 && (
          <p className="routine-empty">{query.trim() ? 'No routines match.' : 'No routines yet. Press + to add one.'}</p>
        )}
      </nav>
    </aside>
  )
}
