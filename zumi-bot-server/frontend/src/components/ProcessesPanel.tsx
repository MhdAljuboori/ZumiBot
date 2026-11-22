import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ProcessInfo } from '@zumibot/shared/processes'
import type { ChatMeta } from '@zumibot/shared/types'
import { isArchived } from '@zumibot/shared/archive'
import { api } from '../api'
import { processActions, processRows, stateLabel, wakeLabel, type ProcessTone } from '../state/processes'
import { useProcessLog } from '../useProcesses'
import { SideBackButton } from './SidePanelMenu'

interface Props {
  chat: ChatMeta
  list: ProcessInfo[] | null
  failed: boolean
  onRetry: () => void
  connected: boolean
  onBack: () => void
  onClose: () => void
}

/** A clock for uptimes, ticking only while something runs. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running])
  return now
}

/** The notify rule, and why its last event woke nobody. */
function WakeLine({ p }: { p: ProcessInfo | undefined }) {
  const label = wakeLabel(p?.wake ?? null)
  if (label === null) return null
  return (
    <span className="process-wake" data-testid="process-wake">
      {label}
      {p?.wake?.note && (
        <span className="process-wake-note" data-testid="process-wake-note">
          {' '}
          · {p.wake.note}
        </span>
      )}
    </span>
  )
}

const Dot = ({ tone }: { tone: ProcessTone }) => <span className={`process-dot ${tone}`} aria-hidden="true" />

/** The chat's background processes; a row opens its live log. */
export function ProcessesPanel({ chat, list, failed, onRetry, connected, onBack, onClose }: Props) {
  const [openId, setOpenId] = useState<string | null>(null)
  const running = (list ?? []).some((p) => p.state === 'running')
  const now = useNow(running)
  const rows = useMemo(() => processRows(list ?? [], now), [list, now])
  const open = openId === null ? undefined : list?.find((p) => p.id === openId)
  // Forgotten (or gone with a reload): back to the list.
  useEffect(() => {
    if (openId !== null && list !== null && !open) setOpenId(null)
  }, [openId, list, open])

  if (openId !== null && open) {
    return <ProcessLog chat={chat} p={open} now={now} connected={connected} onBack={() => setOpenId(null)} onClose={onClose} />
  }
  return (
    <aside className="files-panel side-panel processes-panel" data-testid="processes-panel" aria-label="Processes">
      <header className="files-head">
        <span className="side-head-title">
          <SideBackButton onBack={onBack} />
          <span className="files-title">Processes</span>
        </span>
        <button type="button" className="icon-btn" data-testid="processes-close" aria-label="Close processes" onClick={onClose}>
          ✕
        </button>
      </header>
      <div className="side-list">
        {failed && list === null && (
          <div className="file-note" role="alert">
            Couldn't load processes.{' '}
            <button type="button" className="btn small" data-testid="processes-retry" onClick={onRetry}>
              Retry
            </button>
          </div>
        )}
        {list === null && !failed && <div className="file-note">Loading…</div>}
        {list !== null && list.length === 0 && (
          <div className="file-note" data-testid="processes-empty">
            No processes yet. When an agent starts a dev server, a watcher or a long build, it runs here after the reply and you can read
            and stop it.
          </div>
        )}
        {rows.map((r) => (
          <button
            key={r.id}
            type="button"
            className="dispatch-row process-row"
            data-testid="process-row"
            data-id={r.id}
            data-state={list?.find((p) => p.id === r.id)?.state}
            onClick={() => setOpenId(r.id)}
          >
            <span className="dispatch-row-top">
              <Dot tone={r.tone} />
              <span className="dispatch-name">{r.name}</span>
              <span className={`process-state ${r.tone}`} data-testid="process-state">
                {r.state}
              </span>
              <span className="dispatch-chev" aria-hidden="true">
                ›
              </span>
            </span>
            <code className="process-command" data-tip={r.command}>
              {r.command}
            </code>
            <span className="dispatch-usage">
              {r.by}
              {r.time && <> · {r.time}</>}
            </span>
            <WakeLine p={list?.find((p) => p.id === r.id)} />
          </button>
        ))}
      </div>
    </aside>
  )
}

function ProcessLog({
  chat,
  p,
  now,
  connected,
  onBack,
  onClose
}: {
  chat: ChatMeta
  p: ProcessInfo
  now: number
  connected: boolean
  onBack: () => void
  onClose: () => void
}) {
  const { view, failed } = useProcessLog(chat.id, p.id, connected)
  const [busy, setBusy] = useState<null | 'stop' | 'restart' | 'forget'>(null)
  const [error, setError] = useState<string | null>(null)
  const acts = processActions(p, isArchived(chat))
  const state = stateLabel(p)
  const row = processRows([p], now)[0]
  // Follows the end while the reader is at the bottom; scrolled up, it stays where they are.
  const box = useRef<HTMLPreElement>(null)
  const pinned = useRef(true)
  useLayoutEffect(() => {
    const el = box.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [view?.text])
  const act = (kind: 'stop' | 'restart' | 'forget', run: () => Promise<unknown>): void => {
    setBusy(kind)
    setError(null)
    run()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null))
  }
  return (
    <aside className="files-panel side-panel processes-panel" data-testid="process-log-panel" aria-label={`Process ${p.name}`}>
      <header className="files-head">
        <span className="side-head-title">
          <SideBackButton onBack={onBack} />
          <span className="files-title">{p.name}</span>
        </span>
        <button type="button" className="icon-btn" data-testid="processes-close" aria-label="Close processes" onClick={onClose}>
          ✕
        </button>
      </header>
      <div className="process-head">
        <div className="process-head-line">
          <Dot tone={state.tone} />
          <span className={`process-state ${state.tone}`} data-testid="process-log-state">
            {state.text}
          </span>
          <span className="dispatch-usage">
            {row.by}
            {row.time && <> · {row.time}</>}
            {p.restarts > 0 && <> · restarted {p.restarts}×</>}
          </span>
        </div>
        <code className="process-command full" data-testid="process-log-command">
          {p.command}
        </code>
        <div className="dispatch-usage process-cwd" data-tip={p.cwd}>
          {p.cwd}
        </div>
        <WakeLine p={p} />
        <div className="process-actions">
          {acts.stop && (
            <button
              type="button"
              className="btn small"
              data-testid="process-stop"
              disabled={busy !== null || !connected}
              onClick={() => act('stop', () => api.processes.stop(chat.id, p.id))}
            >
              {busy === 'stop' ? 'Stopping…' : 'Stop'}
            </button>
          )}
          {acts.restart && (
            <button
              type="button"
              className="btn small"
              data-testid="process-restart"
              disabled={busy !== null || !connected}
              onClick={() => act('restart', () => api.processes.restart(chat.id, p.id))}
            >
              {busy === 'restart' ? 'Restarting…' : 'Restart'}
            </button>
          )}
          {acts.forget && (
            <button
              type="button"
              className="btn small"
              data-testid="process-forget"
              disabled={busy !== null || !connected}
              onClick={() =>
                act('forget', async () => {
                  await api.processes.forget(chat.id, p.id)
                  onBack()
                })
              }
            >
              Forget
            </button>
          )}
        </div>
        {error && (
          <div className="file-note error" role="alert" data-testid="process-error">
            {error}
          </div>
        )}
      </div>
      {failed && view === null && (
        <div className="file-note error" role="alert">
          Couldn't load the log.
        </div>
      )}
      <pre
        ref={box}
        className="process-log"
        data-testid="process-log"
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >
        {(view?.dropped ?? 0) > 0 || view?.trimmed ? (
          <span className="process-log-gap">… earlier output is no longer kept{'\n'}</span>
        ) : null}
        {view === null ? (failed ? '' : 'Loading…') : view.text || (p.state === 'running' ? 'No output yet.' : 'No output.')}
      </pre>
    </aside>
  )
}
