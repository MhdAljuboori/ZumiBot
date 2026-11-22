import { useCallback, useEffect, useRef, useState } from 'react'
import { displayName } from '@zumibot/shared/frontmatter'
import type { AgentSummary } from '@zumibot/shared/types'
import { MODERATOR_AGENT, SUMMARY_AGENT, type UsageSummary } from '@zumibot/shared/usageReport'
import { api } from '../api'
import {
  chartBars,
  chatRowOpens,
  costLabel,
  formatMetric,
  formatTokens,
  localDay,
  rangeQuery,
  share,
  sourceSplit,
  tabRows,
  totalsBoxes,
  type UsageMetric,
  type UsageRange,
  type UsageTab
} from '../state/usageReport'
import { useConnected } from '../useConnected'
import { SpendCapsCard } from './SpendCapsCard'
import { UsageChart } from './UsageChart'
import { SearchSelect } from './SearchSelect'

const zone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone
const RANGES: { value: string; label: string; range: UsageRange }[] = [
  { value: '7', label: '7 days', range: 7 },
  { value: '30', label: '30 days', range: 30 },
  { value: '90', label: '90 days', range: 90 },
  { value: 'all', label: 'All time', range: 'all' }
]
const TABS: { tab: UsageTab; label: string; column: string }[] = [
  { tab: 'model', label: 'Model', column: 'Model' },
  { tab: 'agent', label: 'Agent', column: 'Agent' },
  { tab: 'chat', label: 'Chat', column: 'Chat' },
  { tab: 'day', label: 'Day', column: 'Day' }
]

interface Props {
  chatId: string | null
  chatTitle: string | null
  agents: AgentSummary[]
  onClearChat: () => void
  onOpenChat: (chatId: string) => void
}

/** The Usage page: what chats, agents and models cost, every dollar an API list-price estimate. */
export function UsageView({ chatId, chatTitle, agents, onClearChat, onOpenChat }: Props) {
  const [agent, setAgent] = useState('')
  const [metric, setMetric] = useState<UsageMetric>('cost')
  const [range, setRange] = useState<UsageRange>(30)
  const [tab, setTab] = useState<UsageTab>('agent')
  const [sum, setSum] = useState<UsageSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  const load = useCallback(() => {
    const mine = ++seq.current // a slow older answer must not overwrite a newer one
    api.usage.query(rangeQuery(range, Date.now(), zone(), agent === '' ? null : agent, chatId)).then(
      (s) => {
        if (mine === seq.current) {
          setSum(s)
          setError(null)
        }
      },
      (e: unknown) => {
        if (mine === seq.current) setError(e instanceof Error ? e.message : 'Could not load usage')
      }
    )
  }, [range, agent, chatId])
  // Asked again on each reconnect: one made while the socket was down failed, and changes recorded meanwhile were not pushed.
  const connected = useConnected()
  useEffect(() => {
    if (connected) load()
  }, [connected, load])

  // Recording a reply can fire in bursts; one refetch after they settle.
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = api.usage.onChanged(() => {
      clearTimeout(timer)
      timer = setTimeout(() => loadRef.current(), 500)
    })
    return () => {
      clearTimeout(timer)
      off()
    }
  }, [])

  const split = sum ? sourceSplit(sum, metric) : null
  const now = Date.now()
  const from = rangeQuery(range, now, zone(), null, null).from
  const bars = sum ? chartBars(sum.days, metric, from === null ? null : localDay(from, zone()), localDay(now, zone())) : []
  const rows = sum ? tabRows(sum, tab, metric) : []
  const col = TABS.find((t) => t.tab === tab)!.column

  return (
    <div className="usg" data-testid="usage-page">
      <div className="usg-top">
        <h1>Usage</h1>
        <div className="usg-ctl">
          {chatId !== null && (
            <button
              type="button"
              className="usg-chat-filter"
              data-testid="usage-chat-filter"
              data-tip="Show every chat again"
              onClick={onClearChat}
            >
              <span className="usg-chat-name">{chatTitle ?? 'This chat'}</span> ✕
            </button>
          )}
          <SearchSelect className="field" data-testid="usage-agent" aria-label="Agent" value={agent} onChange={(v) => setAgent(v)}>
            <option value="">All agents</option>
            {agents.map((a) => (
              <option key={a.filePath} value={a.name}>
                {displayName(a.name)}
              </option>
            ))}
            <option value={MODERATOR_AGENT}>Room moderator</option>
            <option value={SUMMARY_AGENT}>Room handoff</option>
          </SearchSelect>
          <div className="seg" role="group" aria-label="Metric" data-testid="usage-metric">
            <button type="button" aria-pressed={metric === 'cost'} onClick={() => setMetric('cost')}>
              Cost
            </button>
            <button type="button" aria-pressed={metric === 'tokens'} onClick={() => setMetric('tokens')}>
              Tokens
            </button>
          </div>
          <SearchSelect
            className="field"
            data-testid="usage-range"
            aria-label="Range"
            value={String(range)}
            onChange={(v) => setRange(RANGES.find((r) => r.value === v)!.range)}
          >
            {RANGES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </SearchSelect>
          <button type="button" className="btn small" aria-label="Refresh" data-tip="Refresh" onClick={load}>
            ⟳
          </button>
        </div>
      </div>

      {error && (
        <div className="usg-error" role="alert">
          {error}
        </div>
      )}
      {sum === null || split === null ? (
        !error && <p className="usg-note">Loading…</p>
      ) : (
        <>
          <div className="usg-hero">
            <div className="usg-hero-left">
              <div className="usg-big" data-testid="usage-total">
                {formatMetric(split.total, metric)}
              </div>
              <div className="usg-sub">
                {sum.chats} {sum.chats === 1 ? 'chat' : 'chats'} · {metric === 'cost' ? 'API estimate · USD' : 'tokens without cache reads'}
              </div>
              <div className="usg-leg" data-testid="usage-legend-exact">
                <div className="usg-leg-line">
                  <span>
                    <i className="usg-dot exact" />
                    Exact
                  </span>
                  <span>{formatMetric(split.exact, metric)}</span>
                </div>
                <div className="usg-sub">
                  {split.exactPct} · {formatTokens(sum.exactTokens)} tokens · since this release
                </div>
              </div>
              <div className="usg-leg" data-testid="usage-legend-estimated">
                <div className="usg-leg-line">
                  <span>
                    <i className="usg-dot est" />
                    Estimated
                  </span>
                  <span>{formatMetric(split.estimated, metric)}</span>
                </div>
                <div className="usg-sub">
                  {split.estimatedPct} · {formatTokens(sum.estimatedTokens)} tokens · old chats
                </div>
              </div>
              {sum.estimating && <div className="usg-sub usg-estimating">Estimating old chats…</div>}
              {sum.unpricedTokens > 0 && (
                <div className="usg-sub">Dollar totals leave out {formatTokens(sum.unpricedTokens)} tokens of unpriced models.</div>
              )}
            </div>
            <div className="usg-hero-right">
              <div className="usg-chart-head">
                <strong>{metric === 'cost' ? 'Daily cost' : 'Daily tokens'}</strong>
                <button type="button" className="usg-link" onClick={() => setTab('day')}>
                  View daily data
                </button>
              </div>
              <UsageChart bars={bars} metric={metric} />
            </div>
          </div>

          <div className="usg-totals">
            {totalsBoxes(sum).map((b) => (
              <div key={b.label}>
                <span>{b.label}</span>
                <strong>{b.value}</strong>
              </div>
            ))}
          </div>

          <div className="usg-bd-head">
            <strong>Breakdown</strong>
            <div className="seg" role="group" aria-label="Breakdown">
              {TABS.map((t) => (
                <button
                  key={t.tab}
                  type="button"
                  data-testid={`usage-tab-${t.tab}`}
                  aria-pressed={tab === t.tab}
                  onClick={() => setTab(t.tab)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <div className="usg-table-wrap">
            <table className="usg-table">
              <thead>
                <tr>
                  <th>{col}</th>
                  <th>Cost</th>
                  <th>Share</th>
                  <th>Tokens</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const opens = chatRowOpens(tab, r)
                  return (
                    <tr
                      key={r.key}
                      data-testid="usage-row"
                      data-key={r.key}
                      className={opens ? 'usg-row-link' : undefined}
                      role={opens ? 'link' : undefined}
                      tabIndex={opens ? 0 : undefined}
                      onClick={opens ? () => onOpenChat(r.key) : undefined}
                      onKeyDown={
                        opens
                          ? (e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                onOpenChat(r.key)
                              }
                            }
                          : undefined
                      }
                    >
                      <td>
                        <span className="usg-name">{r.label}</span>
                        {r.estimated && <span className="usg-tag">est.</span>}
                        {r.unpriced && <span className="usg-tag">unpriced</span>}
                      </td>
                      <td>{costLabel(r.costUsd, r.unpriced)}</td>
                      <td>{share(r, rows, metric)}</td>
                      <td>{formatTokens(r.tokens)}</td>
                    </tr>
                  )
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="usg-empty">
                      {sum.estimating ? 'Estimating old chats…' : 'No usage in this range yet.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
      <SpendCapsCard agents={agents} />
    </div>
  )
}
