import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ATTEMPTS_MAX, ATTEMPTS_MIN, type TodoItem } from '@zumibot/shared/todos'
import { attemptsLine, costLine } from '@zumibot/shared/attempts'
import { displayName } from '@zumibot/shared/frontmatter'
import type { AgentSummary, GitChanges } from '@zumibot/shared/types'
import { api } from '../api'
import { errorMessage } from '../errors'
import { useConnected } from '../useConnected'
import {
  addPick,
  attemptRows,
  canAddPick,
  canCompare,
  canDropPick,
  changesLabel,
  defaultPicks,
  dropPick,
  durationLabel,
  folderLine,
  setPick,
  togglePick,
  type AttemptRow
} from '../state/attempts'
import { givableAgents } from '../state/todoCard'
import { engineTag, engineTagOf } from '../state/agentEngine'
import { chipTotalLabel } from '../state/usageReport'
import { AttemptCompare } from './AttemptCompare'
import { Dialog } from './Dialog'
import { SearchSelect } from './SearchSelect'

/** What the card hands the attempts section: the app's lists and the card's own busy guard. */
export interface AttemptsEnv {
  agents: AgentSummary[]
  chats: import('@zumibot/shared/types').ChatMeta[]
  approvals: Record<string, number>
  openChat(chatId: string): void
}

type Run = (what: () => Promise<unknown>) => Promise<boolean>

/** Each attempt's own files-and-lines since its base, and its cost, read once the section shows and after each turn. */
function useAttemptStats(rows: readonly AttemptRow[]): {
  changes: Record<string, GitChanges | null | undefined>
  cost: Record<string, string>
} {
  const [changes, setChanges] = useState<Record<string, GitChanges | null | undefined>>({})
  const [cost, setCost] = useState<Record<string, string>>({})
  // One key per set of chats and their running state: a finished turn reads the numbers again.
  const key = rows.map((r) => `${r.attempt.chatId}:${r.chat?.inFlight === true}`).join(',')
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const connected = useConnected()
  useEffect(() => {
    if (!connected) return
    for (const r of rows) {
      const id = r.attempt.chatId
      api.chats.gitChanges(id, 'base').then(
        (c) => {
          if (live.current) setChanges((prev) => ({ ...prev, [id]: c }))
        },
        () => {
          if (live.current) setChanges((prev) => ({ ...prev, [id]: null }))
        }
      )
      api.usage.query({ from: null, to: null, agent: null, chatId: id, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }).then(
        (s) => {
          if (live.current) setCost((prev) => ({ ...prev, [id]: chipTotalLabel(s) }))
        },
        () => {}
      )
    }
  }, [key, connected]) // eslint-disable-line react-hooks/exhaustive-deps
  return { changes, cost }
}

/** The card's attempts: one row each, Compare on two, and Keep this one. */
export function TodoAttempts({ item, env, run, busy }: { item: TodoItem; env: AttemptsEnv; run: Run; busy: boolean }) {
  const set = item.attempts!
  const rows = attemptRows(item, env.chats, env.approvals)
  const { changes, cost } = useAttemptStats(rows)
  const [picked, setPicked] = useState<string[]>([])
  const [comparing, setComparing] = useState<[string, string] | null>(null)
  const decided = set.winner !== undefined
  const now = Date.now()
  return (
    <section className="todo-card-section todo-attempts" data-testid="todo-attempts">
      <div className="todo-card-head">
        <h4>{decided ? 'Attempts' : `Attempts — ${attemptsLine(rows.map((r) => r.state))}`}</h4>
        <span className="grow" />
        {!decided && (
          <>
            <button
              type="button"
              className="btn small"
              data-testid="attempts-compare"
              disabled={!canCompare(picked)}
              data-tip={canCompare(picked) ? 'See the two diffs side by side' : 'Tick two attempts to compare them'}
              onClick={() => setComparing([picked[0], picked[1]])}
            >
              Compare
            </button>
            <button
              type="button"
              className="btn small"
              data-testid="attempts-cancel"
              disabled={busy}
              data-tip="Drops the set. The chats and their worktrees stay."
              onClick={() => void run(() => api.attempts.cancel(item.id))}
            >
              Cancel set
            </button>
          </>
        )}
      </div>
      <ul className="attempt-rows" data-testid="attempt-rows">
        {rows.map((r) => (
          <li
            key={r.attempt.chatId}
            className={r.winner ? 'attempt-row kept' : 'attempt-row'}
            data-testid="attempt-row"
            data-state={r.state}
            data-agent={r.attempt.agent}
          >
            {!decided && (
              <input
                type="checkbox"
                className="attempt-pick"
                data-testid="attempt-pick"
                checked={picked.includes(r.attempt.chatId)}
                aria-label={`Compare ${displayName(r.attempt.agent)} #${r.attempt.n}`}
                onChange={() => setPicked((p) => togglePick(p, r.attempt.chatId))}
              />
            )}
            <span className="attempt-who">
              <span className="attempt-name">{displayName(r.attempt.agent)}</span>
              <span className="attempt-n">#{r.attempt.n}</span>
              {engineTagOf(r.attempt.engine) && (
                <span className="attempt-engine" data-testid="attempt-engine">
                  {engineTagOf(r.attempt.engine)}
                </span>
              )}
            </span>
            <span className={`attempt-state tone-${r.tone}`} data-testid="attempt-state">
              {r.label}
            </span>
            <span className="attempt-stat" data-testid="attempt-changes">
              {changesLabel(changes[r.attempt.chatId])}
            </span>
            <span className="attempt-stat">{cost[r.attempt.chatId] ?? '—'}</span>
            <span className="attempt-stat">{durationLabel(set.at, r.chat, now)}</span>
            <span className="attempt-row-actions">
              <button
                type="button"
                className="btn small"
                data-testid="attempt-open"
                disabled={r.state === 'gone'}
                onClick={() => env.openChat(r.attempt.chatId)}
              >
                Open →
              </button>
              {r.winner ? (
                <span className="attempt-kept" data-testid="attempt-kept">
                  Kept
                </span>
              ) : (
                !decided && (
                  <button
                    type="button"
                    className="btn small primary"
                    data-testid="attempt-keep"
                    disabled={busy || r.state === 'gone'}
                    data-tip="Gives the card to this attempt and archives the others"
                    onClick={() => void run(() => api.attempts.keep(item.id, r.attempt.chatId))}
                  >
                    Keep this one
                  </button>
                )
              )}
            </span>
          </li>
        ))}
      </ul>
      {set.failed && set.failed.length > 0 && (
        <ul className="attempt-problems" data-testid="attempt-problems">
          {set.failed.map((f, i) => (
            <li key={i}>
              {displayName(f.agent)} did not start: {f.why}
            </li>
          ))}
        </ul>
      )}
      {comparing && (
        <AttemptCompare
          rows={rows.filter((r) => comparing.includes(r.attempt.chatId))}
          onClose={() => setComparing(null)}
          onOpenChat={env.openChat}
        />
      )}
    </section>
  )
}

/** Run attempts…: the agents to try, what it costs, and what it does to the folder. */
export function AttemptsDialog({
  item,
  agents,
  folder,
  isolated,
  onClose,
  onRan
}: {
  item: TodoItem
  agents: AgentSummary[]
  folder: string | undefined
  /** Whether that folder's "Isolate in worktree" toggle is on; undefined while it is still being read. */
  isolated: boolean | undefined
  onClose: () => void
  onRan: () => void
}) {
  const usable = useMemo(() => givableAgents(agents), [agents])
  const [picks, setPicks] = useState<string[]>(() => defaultPicks(usable, item.assignee))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const start = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      // The folder the dialog shows: the card's own when it has one, else the folder of the chat it was made in.
      const r = await api.attempts.start(
        item.id,
        picks.map((agent) => ({ agent })),
        folder ?? null
      )
      if (r.problems.length > 0) {
        setError(r.problems.map((p) => `${displayName(p.agent)}: ${p.why}`).join('\n'))
        setBusy(false)
        onRan()
        return
      }
      onRan()
      onClose()
    } catch (e: unknown) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <Dialog title="Run attempts" onClose={onClose} testId="attempts-dialog">
      <p className="todo-card-hint">
        Each agent gets this card in its own chat and its own git worktree, all from the same commit. Nothing is shared, so they cannot get
        in each other's way.
      </p>
      <ul className="attempt-picks" data-testid="attempt-picks">
        {picks.map((agent, i) => (
          <li key={i} className="attempt-pick-row">
            <span className="attempt-n">#{i + 1}</span>
            <SearchSelect
              className="field"
              data-testid="attempt-pick-agent"
              value={agent}
              aria-label={`Attempt ${i + 1}`}
              onChange={(v) => setPicks((p) => setPick(p, i, v))}
            >
              {usable.map((a) => (
                <option key={a.name} value={a.name}>
                  {displayName(a.name)}
                  {engineTag(a) ? ` (${engineTag(a)})` : ''}
                </option>
              ))}
            </SearchSelect>
            <button
              type="button"
              className="btn small"
              data-testid="attempt-pick-drop"
              disabled={!canDropPick(picks)}
              aria-label={`Remove attempt ${i + 1}`}
              onClick={() => setPicks((p) => dropPick(p, i))}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="btn small"
        data-testid="attempt-pick-add"
        disabled={!canAddPick(picks)}
        onClick={() => setPicks((p) => addPick(p, usable))}
      >
        Add an attempt
      </button>
      <p className="attempt-cost" data-testid="attempt-cost">
        {costLine(picks.length)}
      </p>
      <p className="todo-card-hint" data-testid="attempt-folder">
        {folderLine(folder, isolated)}
      </p>
      {capNotes(picks, agents).map((line, i) => (
        <p key={i} className="attempt-cap" data-testid="attempt-cap">
          {line}
        </p>
      ))}
      {error !== null && (
        <div className="side-error" role="alert" data-testid="attempts-error">
          {error}
        </div>
      )}
      <div className="attempt-actions">
        <button
          type="button"
          className="btn small primary"
          data-testid="attempts-run"
          disabled={busy || isolated === false || picks.length < ATTEMPTS_MIN || picks.length > ATTEMPTS_MAX}
          onClick={() => void start()}
        >
          {busy ? 'Starting…' : `Run ${picks.length} attempts`}
        </button>
        <button type="button" className="btn small" data-testid="attempts-close" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Dialog>
  )
}

/** One line per agent in the set that has a daily spend cap: its turns here count against that cap like any other. */
function capNotes(picks: readonly string[], agents: readonly AgentSummary[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const name of picks) {
    if (seen.has(name)) continue
    seen.add(name)
    const cap = agents.find((a) => a.name === name)?.dailySpendCap
    if (cap !== undefined)
      out.push(
        `${displayName(name)} has a daily spend cap of $${cap}. Its attempt pauses if the day runs out, and Settings › Usage › Spend caps allows more.`
      )
  }
  return out
}
