import type { ComponentProps } from 'react'
import { JEV_CONDITION_MAX } from '@zumibot/shared/jev'
import type { Schedule } from '@zumibot/shared/routines'
import type { RoutineDraft } from '../state/routineDraft'
import { CardHead } from './RoutineIcons'
import { SchedulePicker } from './SchedulePicker'
import { WebhookPanel } from './WebhookPanel'
import { SearchSelect } from './SearchSelect'

interface Props {
  draft: RoutineDraft
  now: number
  today: string
  onKind: (k: RoutineDraft['triggerKind']) => void
  onSchedule: (s: Schedule) => void
  webhook: ComponentProps<typeof WebhookPanel>
  /** Jev is on with a key: a webhook condition is checked. Off, the field shows only to say a saved condition is ignored. */
  jevOn: boolean
  onCondition: (condition: string) => void
}

export function TriggerCard({ draft, now, today, onKind, onSchedule, webhook, jevOn, onCondition }: Props) {
  return (
    <section className="rt-card" data-testid="trigger-card">
      <CardHead icon="calendar" title="Trigger" subtitle="When should this routine run?">
        <SearchSelect
          className="rt-select"
          data-testid="trigger-kind"
          aria-label="Trigger"
          value={draft.triggerKind}
          onChange={(v) => onKind(v as RoutineDraft['triggerKind'])}
        >
          <option value="schedule">Schedule</option>
          <option value="manual">Manual only</option>
          <option value="webhook">Webhook</option>
        </SearchSelect>
      </CardHead>
      {draft.triggerKind === 'schedule' && (
        <SchedulePicker schedule={draft.schedule} timeZone={draft.timeZone} now={now} today={today} onChange={onSchedule} />
      )}
      {draft.triggerKind === 'manual' && <div className="rt-hint">Runs only when you press Run now.</div>}
      {draft.triggerKind === 'webhook' && <WebhookPanel {...webhook} />}
      {draft.triggerKind === 'webhook' && (jevOn || draft.condition.trim() !== '') && (
        <div className="rt-condition" data-testid="webhook-condition">
          <div className="rt-label">Only run when (optional)</div>
          <textarea
            className="rt-input"
            data-testid="webhook-condition-input"
            aria-label="Only run when"
            rows={2}
            maxLength={JEV_CONDITION_MAX}
            placeholder="The CI run failed on the main branch"
            value={draft.condition}
            onChange={(e) => onCondition(e.target.value)}
          />
          <div className={jevOn ? 'rt-hint' : 'rt-hint rt-bad'}>
            {jevOn
              ? 'Jev reads each call and skips the run when this is not true. Leave it empty to run on every call.'
              : 'Jev is off, so this is ignored and every call runs. Turn Jev on in Settings › Jev decisions.'}
          </div>
        </div>
      )}
    </section>
  )
}
