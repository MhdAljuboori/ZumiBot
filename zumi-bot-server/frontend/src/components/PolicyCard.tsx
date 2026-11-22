import type { LimitPolicy, MissedPolicy, SessionPolicy } from '@zumibot/shared/routines'
import type { RoutineDraft } from '../state/routineDraft'
import { CardHead } from './RoutineIcons'
import { CapBlocked, SpendCapInput } from './SpendCapInput'
import { SearchSelect } from './SearchSelect'

interface Props {
  draft: RoutineDraft
  edit: (fn: (d: RoutineDraft) => RoutineDraft) => void
  /** Why the spend cap can't be set (an agent's engine reports no cost); null while it can. */
  capBlocked: string | null
}

/**
 * What a run does when the usage limit stops it, (schedule only) when ZumiBot was off at its time, and (existing chat
 * only) whether the agents keep their sessions between runs.
 */
export function PolicyCard({ draft, edit, capBlocked }: Props) {
  return (
    <section className="rt-card" data-testid="policy-card">
      <CardHead icon="shield" title="How each run goes" subtitle="Usage limits, spend cap, missed times and agent sessions" />
      <div className="rt-grid">
        <label className="rt-fieldset">
          <span className="rt-label">Usage limit hit</span>
          <SearchSelect
            className="rt-select"
            data-testid="limit-policy"
            value={draft.limitPolicy}
            onChange={(v) => {
              const limitPolicy = v as LimitPolicy
              edit((d) => ({ ...d, limitPolicy }))
            }}
          >
            <option value="wait">Wait, then continue</option>
            <option value="skip">Skip the run</option>
          </SearchSelect>
          <span className="rt-hint">
            {draft.limitPolicy === 'wait'
              ? 'Sends "continue" in the same chat once the limit resets.'
              : 'The run ends where the limit stopped it, marked skipped.'}
          </span>
        </label>
        <div className="rt-fieldset">
          <label className="rt-label" htmlFor="routine-spend-cap">
            Spend cap per run
          </label>
          {capBlocked === null ? (
            <>
              <SpendCapInput
                id="routine-spend-cap"
                value={draft.spendCap}
                onChange={(spendCap) => edit((d) => ({ ...d, spendCap }))}
                testId="routine-spend-cap"
                routine
              />
              <span className="rt-hint">
                {draft.spendCap === null
                  ? 'No cap: a run spends what it needs.'
                  : 'Once a run has spent this much, priced at API rates, its chat pauses and you are notified. Resume allows the same again.'}
              </span>
            </>
          ) : (
            <CapBlocked
              reason={capBlocked}
              hasCap={draft.spendCap !== null}
              testId="routine-spend-cap-blocked"
              onClear={() => edit((d) => ({ ...d, spendCap: null }))}
            />
          )}
        </div>
        {draft.triggerKind === 'schedule' && (
          <label className="rt-fieldset">
            <span className="rt-label">Missed while off</span>
            <SearchSelect
              className="rt-select"
              data-testid="missed-policy"
              value={draft.missedPolicy}
              onChange={(v) => {
                const missedPolicy = v as MissedPolicy
                edit((d) => ({ ...d, missedPolicy }))
              }}
            >
              <option value="run-once">Run once when back</option>
              <option value="skip">Skip it</option>
            </SearchSelect>
            <span className="rt-hint">
              {draft.missedPolicy === 'run-once'
                ? 'ZumiBot was off at the time: one late run, however many were missed.'
                : 'ZumiBot was off at the time: no run, it waits for the next one.'}
            </span>
          </label>
        )}
        {draft.chatChoice !== 'new' && (
          <label className="rt-fieldset">
            <span className="rt-label">Agent sessions</span>
            <SearchSelect
              className="rt-select"
              data-testid="session-policy"
              value={draft.sessionPolicy}
              onChange={(v) => {
                const sessionPolicy = v as SessionPolicy
                edit((d) => ({ ...d, sessionPolicy }))
              }}
            >
              <option value="continue">Continue from the last run</option>
              <option value="fresh">Start fresh each run</option>
            </SearchSelect>
            <span className="rt-hint">
              {draft.sessionPolicy === 'continue'
                ? 'The agents keep everything from earlier runs. After a few idle hours a big chat is reloaded in full, which uses many tokens.'
                : "Each run starts new agent sessions from the chat's recent messages. Uses far fewer tokens; older details stay in the chat but not in the agents' memory."}
            </span>
          </label>
        )}
      </div>
    </section>
  )
}
