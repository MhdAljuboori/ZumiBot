import type { RoutineRun } from '@zumibot/shared/routines'
import { conditionLabel, missingLabel, pauseLabel, policyLabel, runLabel, viaLabel } from '../state/promptFields'
import { costText } from '../state/workflowRun'
import { CardHead } from './RoutineIcons'

interface Props {
  runs: RoutineRun[]
  now: number
  timeZone: string
  /** Ids of chats that still exist: a deleted chat cannot be opened. */
  chatIds: ReadonlySet<string>
  onOpenChat: (chatId: string) => void
}

export function RecentRuns({ runs, now, timeZone, chatIds, onOpenChat }: Props) {
  const rows = [...runs].sort((a, b) => b.startedAt - a.startedAt)
  return (
    <section className="rt-runs" data-testid="recent-runs">
      <CardHead icon="history" title="Recent runs" subtitle="Latest executions" />
      {rows.length === 0 && (
        <div className="rt-empty" data-testid="runs-empty">
          <svg
            className="rt-empty-art"
            viewBox="0 0 48 48"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="24" cy="26" r="14" />
            <path d="M24 18v8l-5 5M24 26l5 5M34 10l2-3M40 14l3-1M30 7l.5-3" />
          </svg>
          <strong>No runs yet</strong>
          <span>This routine hasn't run yet.</span>
        </div>
      )}
      {rows.length > 0 && (
        <div className="rt-runs-list" data-testid="runs-list">
          {rows.map((r) => {
            const missing = missingLabel(r)
            const condition = conditionLabel(r)
            const policy = policyLabel(r, now, timeZone)
            const pause = pauseLabel(r)
            const via = viaLabel(r)
            return (
              <div key={r.id} className="rt-run" data-testid="run-row" data-status={r.status}>
                <div className="rt-run-top">
                  <span className={`routine-dot ${r.status}`} aria-hidden="true" />
                  <span className="rt-run-when">{runLabel(r, now, timeZone)}</span>
                  <span className="rt-run-status">{r.status}</span>
                  {via && (
                    <span className="rt-tag rt-tag-plain" data-testid="run-via">
                      {via}
                    </span>
                  )}
                  {r.late && (
                    <span className="rt-tag" data-testid="run-late">
                      late
                    </span>
                  )}
                  {costText(r.costUsd) && (
                    <span className="rt-tag rt-tag-plain" data-testid="run-cost" data-tip="What this run's turns cost, at API prices">
                      {costText(r.costUsd)}
                    </span>
                  )}
                  <span className="rt-grow" />
                  {r.chatId !== null && (
                    <button
                      type="button"
                      className="rt-insert"
                      data-testid="run-open-chat"
                      disabled={!chatIds.has(r.chatId)}
                      onClick={() => onOpenChat(r.chatId as string)}
                    >
                      Open chat
                    </button>
                  )}
                </div>
                {r.status === 'failed' && r.error && <div className="rt-run-error">{r.error}</div>}
                {missing && (
                  <div className="rt-run-missing" data-testid="run-missing">
                    {missing}
                  </div>
                )}
                {condition && (
                  <div className="rt-run-condition" data-testid="run-condition">
                    {condition}
                  </div>
                )}
                {policy && (
                  <div className="rt-run-condition" data-testid="run-policy">
                    {policy}
                  </div>
                )}
                {pause && (
                  <div className="rt-run-condition" data-testid="run-pause">
                    {pause}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
