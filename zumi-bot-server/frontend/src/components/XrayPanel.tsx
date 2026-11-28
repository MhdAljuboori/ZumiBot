import { useEffect, useMemo, useState } from 'react'
import { decisionLabel } from '@zumibot/shared/audit'
import { displayName } from '@zumibot/shared/frontmatter'
import type { TurnXray } from '@zumibot/shared/xray'
import { api } from '../api'
import { decisionTone } from '../state/auditRecords'
import { formatTokens } from '../state/usageReport'
import {
  GAP_TEXT,
  OUTCOME_TEXT,
  barOf,
  cacheShare,
  callBars,
  callLabel,
  costText,
  countsLine,
  fineUsd,
  modelLabel,
  spanText,
  splitOf,
  stepLine,
  stepTitle,
  tokenTotal,
  waitText,
  xrayRows,
  type XrayRow
} from '../state/xray'
import { SideBackButton } from './SidePanelMenu'

interface Props {
  chatId: string
  /** The reply's message; a new one (or the same one again, `focusRequest`) loads again. */
  itemId: string
  focusRequest: number
  connected: boolean
  onBack: () => void
  onClose: () => void
}

const POLL_MS = 2000 // while the reply runs; the server reads it from the stores on every ask

const when = (ms: number): string => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

type Load = { state: 'loading' } | { state: 'failed' } | { state: 'gone' } | { state: 'ok'; x: TurnXray }

/** One reply's timeline: requests, tool calls, subagents and card waits on one time axis, with tokens and cost. */
export function XrayPanel({ chatId, itemId, focusRequest, connected, onBack, onClose }: Props) {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [retry, setRetry] = useState(0)
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    setLoad({ state: 'loading' })
    setOpen(new Set())
  }, [chatId, itemId, focusRequest])

  const running = load.state === 'ok' && load.x.running
  useEffect(() => {
    if (!connected) return
    let stop = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const fetchOnce = async (): Promise<void> => {
      try {
        const x = await api.xray.get(chatId, itemId)
        if (stop) return
        setNow(Date.now())
        setLoad(x === null ? { state: 'gone' } : { state: 'ok', x })
        if (x?.running) timer = setTimeout(() => void fetchOnce(), POLL_MS)
      } catch {
        if (!stop) setLoad((prev) => (prev.state === 'ok' ? prev : { state: 'failed' }))
      }
    }
    void fetchOnce()
    return () => {
      stop = true
      if (timer) clearTimeout(timer)
    }
  }, [chatId, itemId, focusRequest, retry, connected])

  // Bars of a running reply grow between fetches.
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running])

  const rows = useMemo(() => (load.state === 'ok' ? xrayRows(load.x.run, open) : []), [load, open])
  const toggle = (id: string): void =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <aside className="files-panel side-panel xray-panel" data-testid="xray-panel" aria-label="Turn X-ray">
      <header className="files-head">
        <span className="side-head-title">
          <SideBackButton onBack={onBack} />
          <span className="files-title">Turn X-ray</span>
        </span>
        <button type="button" className="icon-btn" data-testid="xray-close" aria-label="Close turn X-ray" onClick={onClose}>
          ✕
        </button>
      </header>
      <div className="side-list">
        {load.state === 'loading' && <div className="file-note">Loading…</div>}
        {load.state === 'failed' && (
          <div className="file-note" role="alert">
            Couldn't load this reply's X-ray.{' '}
            <button type="button" className="btn small" data-testid="xray-retry" onClick={() => setRetry((n) => n + 1)}>
              Retry
            </button>
          </div>
        )}
        {load.state === 'gone' && (
          <div className="file-note" data-testid="xray-gone">
            This reply is no longer in the chat (an edit or resend may have replaced it).
          </div>
        )}
        {load.state === 'ok' && <XrayBody x={load.x} rows={rows} now={now} onToggle={toggle} />}
      </div>
    </aside>
  )
}

function XrayBody({ x, rows, now, onToggle }: { x: TurnXray; rows: XrayRow[]; now: number; onToggle: (id: string) => void }) {
  const t0 = x.startedAt
  const t1 = x.endedAt ?? now
  const live = x.running ? { ...x, totals: { ...x.totals, durationMs: Math.max(x.totals.durationMs, now - t0) } } : x
  const split = splitOf(live)
  const cost = costText(x)
  const share = cacheShare(x.totals.tokens)
  return (
    <>
      <section className="xray-summary" data-testid="xray-summary">
        <div className="xray-who">
          <span className="xray-agent">{displayName(x.agent)}</span>
          <span className="xray-when">{when(x.startedAt)}</span>
          {x.running && (
            <span className="xray-live" data-testid="xray-live">
              Running
            </span>
          )}
        </div>
        <div className="xray-stats">
          <Stat label="Time" value={spanText(live.totals.durationMs)} testId="xray-time" />
          <Stat
            label={cost.exact ? 'Cost' : 'Cost (est.)'}
            value={cost.text}
            testId="xray-cost"
            tip={cost.exact ? 'What the run reported it cost' : "Priced from each request's tokens"}
          />
          <Stat label="Tokens" value={formatTokens(tokenTotal(x.totals.tokens))} testId="xray-tokens" />
          <Stat label="Cache" value={share === null ? '–' : `${share}%`} testId="xray-cache" tip="Share of the prompt read from the cache" />
        </div>
        <div className="xray-split" aria-hidden="true">
          <span className="xray-split-part model" style={{ width: `${split.model}%` }} />
          <span className="xray-split-part tools" style={{ width: `${split.tools}%` }} />
          <span className="xray-split-part wait" style={{ width: `${split.wait}%` }} />
        </div>
        <div className="xray-legend" data-testid="xray-split">
          <span>
            <i className="xray-key model" /> Model {spanText(live.totals.modelMs)}
          </span>
          <span>
            <i className="xray-key tools" /> Tools {spanText(Math.max(0, live.totals.durationMs - live.totals.modelMs - live.totals.waitMs))}
          </span>
          <span>
            <i className="xray-key wait" /> Waiting on you {spanText(live.totals.waitMs)}
          </span>
        </div>
        <div className="xray-counts" data-testid="xray-counts">
          {countsLine(x)}
          {x.totals.exactUsd !== null && x.totals.requests > 0 && x.totals.stepUsd > 0 && (
            <span className="xray-dim" data-tip="Requests priced from the table, subagents included">
              {' '}
              · requests ≈ {fineUsd(x.totals.stepUsd)}
            </span>
          )}
        </div>
        {x.gaps.map((g) => (
          <div key={g} className="xray-gap" data-testid="xray-gap" data-gap={g}>
            {GAP_TEXT[g]}
          </div>
        ))}
      </section>
      {rows.length === 0 ? (
        <div className="file-note" data-testid="xray-empty">
          {x.running ? 'Nothing yet. Steps show here as the reply works.' : 'This reply made no requests or tool calls that ZumiBot kept.'}
        </div>
      ) : (
        <ol className="xray-rows" data-testid="xray-rows">
          {rows.map((r) => (
            <XrayRowView key={r.key} row={r} t0={t0} t1={t1} now={now} onToggle={onToggle} />
          ))}
        </ol>
      )}
    </>
  )
}

function Stat({ label, value, testId, tip }: { label: string; value: string; testId: string; tip?: string }) {
  return (
    <div className="xray-stat" data-testid={testId} {...(tip ? { 'data-tip': tip } : {})}>
      <span className="xray-stat-value">{value}</span>
      <span className="xray-stat-label">{label}</span>
    </div>
  )
}

function XrayRowView({ row, t0, t1, now, onToggle }: { row: XrayRow; t0: number; t1: number; now: number; onToggle: (id: string) => void }) {
  const indent = { paddingInlineStart: `${12 + row.depth * 14}px` }
  if (row.kind === 'step') {
    const s = row.step
    const bar = barOf(s.startedAt, s.endedAt, t0, t1)
    return (
      <li className="xray-row step" style={indent} data-testid="xray-step" data-id={s.id ?? ''}>
        <div className="xray-row-head">
          <span className="xray-row-title">
            <span className="xray-model">{modelLabel(s.model)}</span> {stepTitle(s)}
          </span>
          <span className="xray-row-time">{spanText(s.endedAt - s.startedAt)}</span>
        </div>
        <div className="xray-track">
          <span className="xray-bar model" style={{ left: `${bar.left}%`, width: `${bar.width}%` }} />
        </div>
        {s.tokens && <div className="xray-row-meta">{stepLine(s)}</div>}
      </li>
    )
  }
  const c = row.call
  const bars = callBars(c, t0, t1, now)
  const end = c.endedAt ?? (c.outcome === 'running' ? now : c.startedAt)
  const wait = waitText(c)
  const bad = c.outcome === 'error' || c.outcome === 'blocked'
  const isAgent = c.run !== null
  const label = callLabel(c)
  return (
    <li
      className={`xray-row call${isAgent ? ' agent' : ''}`}
      style={indent}
      data-testid="xray-call"
      data-id={c.id}
      data-tool={c.tool}
      data-outcome={c.outcome}
    >
      <div className="xray-row-head">
        {isAgent ? (
          <button
            type="button"
            className="xray-fold"
            data-testid="xray-fold"
            aria-expanded={!row.folded}
            aria-label={row.folded ? 'Show what the subagent did' : 'Hide what the subagent did'}
            onClick={() => onToggle(c.id)}
          >
            {row.folded ? '▸' : '▾'}
          </button>
        ) : null}
        <span className="xray-row-title" data-tip={c.summary}>
          <span className="xray-tool">{label.tool}</span> <span className="xray-summary-text">{label.rest}</span>
        </span>
        <span className="xray-row-time">{c.outcome === 'cut' && c.endedAt === null ? '–' : spanText(end - c.startedAt)}</span>
      </div>
      <div className="xray-track">
        <span
          className={`xray-bar ${isAgent ? 'agent' : 'tool'}${bad ? ' bad' : ''}${c.outcome === 'running' ? ' running' : ''}`}
          style={{ left: `${bars.run.left}%`, width: `${bars.run.width}%` }}
        />
        {bars.wait && <span className="xray-bar wait" style={{ left: `${bars.wait.left}%`, width: `${bars.wait.width}%` }} />}
      </div>
      {(wait !== null || c.decision !== null || c.outcome !== 'ok') && (
        <div className="xray-row-meta chips">
          {wait !== null && (
            <span className="xray-wait" data-testid="xray-wait">
              {wait}
            </span>
          )}
          {c.decision !== null && <span className={`audit-chip ${decisionTone(c.decision)}`}>{decisionLabel(c.decision)}</span>}
          {c.outcome !== 'ok' && <span className={`xray-outcome ${c.outcome}`}>{OUTCOME_TEXT[c.outcome]}</span>}
        </div>
      )}
    </li>
  )
}
