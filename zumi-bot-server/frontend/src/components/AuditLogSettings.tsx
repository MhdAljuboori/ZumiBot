import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AUDIT_CAPS,
  AUDIT_OUTCOMES,
  decisionLabel,
  type AuditFacets,
  type AuditOutcome,
  type AuditRecord,
  type AuditRow,
  type AuditStatus,
  type AuditVerify
} from '@zumibot/shared/audit'
import { byEngine, ENGINE_LABEL } from '@zumibot/shared/engine'
import { api } from '../api'
import { errorMessage } from '../errors'
import {
  DECISION_OPTIONS,
  EMPTY_CONTROLS,
  OUTCOME_LABELS,
  decisionTone,
  decisionWhy,
  durationText,
  filterOf,
  recordJson,
  sizeText,
  whoText,
  type AuditControls,
  type AuditRange
} from '../state/auditRecords'
import { useConnected } from '../useConnected'
import { SearchSelect } from './SearchSelect'

const PAGE = 100

interface Props {
  /** A chat's title for the list and the chat filter; null when the chat is gone. */
  chatTitle(chatId: string): string | null
  /** Opens the chat scrolled to the item (the call's row or its subagent's Agent row). */
  onOpenItem(chatId: string, itemId: string | null): void
}

const timeText = (ts: number): string =>
  new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** Settings › Audit log: every tool call any agent made on this machine, newest first. Read-only. */
export function AuditLogSettings(p: Props) {
  const [controls, setControls] = useState<AuditControls>(EMPTY_CONTROLS)
  const [rows, setRows] = useState<AuditRow[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fresh, setFresh] = useState(false)
  const [facets, setFacets] = useState<AuditFacets>({ agents: [], tools: [], chats: [] })
  const [status, setStatus] = useState<AuditStatus | null>(null)
  const [verify, setVerify] = useState<AuditVerify | 'busy' | null>(null)
  const [open, setOpen] = useState<{ row: AuditRow; record: AuditRecord | null } | null>(null)
  const [exporting, setExporting] = useState(false)
  // Each load carries its number: an older answer that lands late never replaces a newer filter's rows.
  const seq = useRef(0)
  const end = useRef<HTMLDivElement | null>(null)

  // The controls whose first page is shown: a reconnect reloads only rows that never landed, not a list scrolled through.
  const shownFor = useRef<AuditControls | null>(null)
  const load = useCallback(async (c: AuditControls, cursor: string | null) => {
    const n = ++seq.current
    setLoading(true)
    setError(null)
    try {
      const page = await api.audit.list(filterOf(c, Date.now()), cursor, PAGE)
      if (n !== seq.current) return
      setRows((old) => (cursor === null ? page.rows : [...old, ...page.rows]))
      setNext(page.next)
      if (cursor === null) {
        setFresh(false)
        shownFor.current = c
      }
    } catch (e) {
      if (n === seq.current) setError(errorMessage(e))
    } finally {
      if (n === seq.current) setLoading(false)
    }
  }, [])

  const refreshSide = useCallback(() => {
    void api.audit.facets().then(setFacets, () => {})
    void api.audit.status().then(setStatus, () => {})
  }, [])

  // A typed search waits a moment; every other control reloads at once. Nothing is asked while the socket is down.
  const connected = useConnected()
  useEffect(() => {
    if (!connected || shownFor.current === controls) return
    const t = setTimeout(() => void load(controls, null), controls.q ? 300 : 0)
    return () => clearTimeout(t)
  }, [controls, load, connected])

  useEffect(() => {
    if (connected) refreshSide()
  }, [connected, refreshSide])
  useEffect(
    () =>
      api.audit.onChanged(() => {
        setFresh(true)
        refreshSide()
      }),
    [refreshSide]
  )

  // The next page loads as the list's end scrolls into view.
  useEffect(() => {
    const el = end.current
    if (!el || next === null) return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !loading) void load(controls, next)
    })
    io.observe(el)
    return () => io.disconnect()
  }, [next, loading, controls, load])

  const set = <K extends keyof AuditControls>(k: K, v: AuditControls[K]) => setControls((c) => ({ ...c, [k]: v }))

  const openRow = async (row: AuditRow) => {
    setOpen({ row, record: null })
    try {
      const record = await api.audit.get(row.id, row.at)
      setOpen((o) => (o?.row.id === row.id ? { row, record } : o))
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const runVerify = async () => {
    setVerify('busy')
    try {
      setVerify(await api.audit.verify())
    } catch (e) {
      setVerify(null)
      setError(errorMessage(e))
    }
  }

  const changeCap = async (bytes: number) => {
    try {
      setStatus(await api.audit.setCap(bytes))
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  // JSON Lines of the filtered range, oldest first. The filter goes in the body, never the URL.
  const exportRange = async () => {
    setExporting(true)
    try {
      const res = await fetch('/api/audit/export', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(filterOf(controls, Date.now()))
      })
      if (!res.ok)
        throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `Export failed (${res.status})`)
      const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'audit.jsonl'
      const url = URL.createObjectURL(await res.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = name
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setExporting(false)
    }
  }

  const chatName = (id: string) => p.chatTitle(id) ?? 'Deleted chat'

  return (
    <div className="audit" data-testid="audit-page">
      <p className="set-hint">
        Every tool call an agent made on this server, with who decided it and how. Inputs are stored with vault values, browser input and
        known secret shapes removed. Agents cannot read or change this log.
      </p>

      <div className="audit-toolbar">
        <input
          className="field audit-search"
          type="search"
          placeholder="Search tool and input"
          aria-label="Search tool and input"
          data-testid="audit-search"
          value={controls.q}
          onChange={(e) => set('q', e.target.value)}
        />
        <button type="button" className="btn small" data-testid="audit-export" disabled={exporting} onClick={() => void exportRange()}>
          {exporting ? 'Exporting…' : 'Export'}
        </button>
      </div>
      <div className="audit-filters">
        <SearchSelect
          className="field"
          aria-label="Agent"
          data-testid="audit-agent"
          value={controls.agent}
          onChange={(v) => set('agent', v)}
        >
          <option value="">All agents</option>
          {facets.agents.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </SearchSelect>
        <SearchSelect
          className="field"
          aria-label="Chat"
          data-testid="audit-chat"
          value={controls.chatId}
          onChange={(v) => set('chatId', v)}
        >
          <option value="">All chats</option>
          {facets.chats.map((c) => (
            <option key={c} value={c}>
              {chatName(c)}
            </option>
          ))}
        </SearchSelect>
        <SearchSelect className="field" aria-label="Tool" data-testid="audit-tool" value={controls.tool} onChange={(v) => set('tool', v)}>
          <option value="">All tools</option>
          {facets.tools.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </SearchSelect>
        <SearchSelect
          className="field"
          aria-label="Decision"
          data-testid="audit-decision"
          value={controls.decision}
          onChange={(v) => set('decision', v as AuditControls['decision'])}
        >
          <option value="">All decisions</option>
          {DECISION_OPTIONS.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </SearchSelect>
        <SearchSelect
          className="field"
          aria-label="Outcome"
          data-testid="audit-outcome"
          value={controls.outcome}
          onChange={(v) => set('outcome', v as AuditOutcome | '')}
        >
          <option value="">All outcomes</option>
          {AUDIT_OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {OUTCOME_LABELS[o]}
            </option>
          ))}
        </SearchSelect>
        <SearchSelect
          className="field"
          aria-label="Time"
          data-testid="audit-range"
          value={controls.range}
          onChange={(v) => set('range', v as AuditRange)}
        >
          <option value="all">Any time</option>
          <option value="hour">Last hour</option>
          <option value="day">Last day</option>
          <option value="week">Last week</option>
          <option value="custom">Custom…</option>
        </SearchSelect>
        {controls.range === 'custom' && (
          <>
            <input
              className="field"
              type="date"
              aria-label="From"
              data-testid="audit-from"
              value={controls.fromDay}
              onChange={(e) => set('fromDay', e.target.value)}
            />
            <input
              className="field"
              type="date"
              aria-label="To"
              data-testid="audit-to"
              value={controls.toDay}
              onChange={(e) => set('toDay', e.target.value)}
            />
          </>
        )}
        {controls !== EMPTY_CONTROLS && (
          <button type="button" className="btn ghost small" data-testid="audit-clear" onClick={() => setControls(EMPTY_CONTROLS)}>
            Clear
          </button>
        )}
      </div>

      {fresh && (
        <button type="button" className="btn small audit-fresh" data-testid="audit-fresh" onClick={() => void load(controls, null)}>
          New records — show them
        </button>
      )}
      {error && (
        <p className="set-note bad" role="alert" data-testid="audit-error">
          {error}
        </p>
      )}

      {open && (
        <div className="set-card audit-record" data-testid="audit-record">
          <div className="audit-record-head">
            <strong>{open.row.tool}</strong>
            <span className="grow" />
            {open.record && open.record.runKind !== 'side' && (
              <button
                type="button"
                className="btn small"
                data-testid="audit-show-in-chat"
                onClick={() => p.onOpenItem(open.row.chatId, open.record?.itemId ?? null)}
              >
                Show in chat
              </button>
            )}
            <button type="button" className="btn ghost small" data-testid="audit-record-close" onClick={() => setOpen(null)}>
              Close
            </button>
          </div>
          {open.record === null ? (
            <p className="set-hint">Loading…</p>
          ) : (
            <>
              <p className="audit-why" data-testid="audit-why">
                {decisionWhy(open.record.decision, open.record.mode)}
              </p>
              <dl className="audit-facts">
                <dt>When</dt>
                <dd>
                  {new Date(open.record.ts).toLocaleString()}
                  {open.record.durationMs !== null ? ` · ${durationText(open.record.durationMs)}` : ''}
                </dd>
                <dt>Agent</dt>
                <dd>
                  {whoText(open.record.agent, open.record.subagent)} · {byEngine(ENGINE_LABEL, open.record.engine, open.record.engine)} ·{' '}
                  {open.record.runKind}
                </dd>
                <dt>Chat</dt>
                <dd>{chatName(open.record.chatId)}</dd>
                {open.record.workflow && (
                  <>
                    <dt>Workflow</dt>
                    <dd>
                      run {open.record.workflow.runId}, step {open.record.workflow.stepId}
                    </dd>
                  </>
                )}
                {open.record.routine && (
                  <>
                    <dt>Routine</dt>
                    <dd>{open.record.routine.id}</dd>
                  </>
                )}
                <dt>Outcome</dt>
                <dd>
                  {OUTCOME_LABELS[open.record.outcome]}
                  {open.record.error ? `: ${open.record.error}` : ''}
                </dd>
                {open.record.inputCut !== null && (
                  <>
                    <dt>Input</dt>
                    <dd>cut from {open.record.inputCut.toLocaleString()} characters</dd>
                  </>
                )}
              </dl>
              <pre className="audit-json" data-testid="audit-json">
                {recordJson(open.record)}
              </pre>
            </>
          )}
        </div>
      )}

      <div className="set-card audit-list" role="list" data-testid="audit-list">
        {rows.length === 0 && !loading && (
          <p className="set-hint audit-empty" data-testid="audit-empty">
            No records match.
          </p>
        )}
        {rows.map((r) => (
          <button
            key={r.id}
            type="button"
            role="listitem"
            className={open?.row.id === r.id ? 'audit-row open' : 'audit-row'}
            data-testid="audit-row"
            data-tool={r.tool}
            data-decision={r.decision.kind}
            onClick={() => void openRow(r)}
          >
            <span className="audit-time">{timeText(r.ts)}</span>
            <span className="audit-main">
              <span className="audit-line">
                <strong>{r.tool}</strong>{' '}
                <span className="audit-who">
                  {whoText(r.agent, r.subagent)} · {chatName(r.chatId)}
                </span>
              </span>
              <span className="audit-summary">{r.summary}</span>
            </span>
            <span className={`audit-chip ${decisionTone(r.decision)}`} data-tip={decisionLabel(r.decision)}>
              {decisionLabel(r.decision)}
            </span>
            <span className="audit-outcome">
              {OUTCOME_LABELS[r.outcome]}
              {r.durationMs !== null ? ` · ${durationText(r.durationMs)}` : ''}
            </span>
          </button>
        ))}
        <div ref={end} />
        {loading && <p className="set-hint audit-empty">Loading…</p>}
      </div>

      <div className="audit-foot" data-testid="audit-status">
        {status && (
          <>
            <span>
              This machine ({status.machine}) · {status.records.toLocaleString()} records · {sizeText(status.bytes)} of
            </span>
            <SearchSelect
              className="field"
              aria-label="Size cap"
              data-testid="audit-cap"
              value={status.cap}
              onChange={(v) => void changeCap(Number(v))}
            >
              {AUDIT_CAPS.map((c) => (
                <option key={c} value={c}>
                  {sizeText(c)}
                </option>
              ))}
            </SearchSelect>
            {status.failures > 0 && (
              <span className="set-note bad">{status.failures} records could not be written since the server started</span>
            )}
          </>
        )}
        <span className="grow" />
        <button
          type="button"
          className="btn small"
          data-testid="audit-verify"
          disabled={verify === 'busy'}
          onClick={() => void runVerify()}
        >
          Verify chain
        </button>
        {verify !== null && verify !== 'busy' && (
          <span className={verify.ok ? 'set-note' : 'set-note bad'} data-testid="audit-verify-result">
            {verify.ok ? `Chain intact (${verify.files} files)` : `Chain broken at ${verify.file}, line ${verify.line}`}
          </span>
        )}
      </div>
    </div>
  )
}
