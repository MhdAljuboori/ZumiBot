import type { RoutineDraft } from '../state/routineDraft'
import { CardHead } from './RoutineIcons'

const RUNS: Record<RoutineDraft['triggerKind'], string> = {
  schedule: 'The routine will run automatically based on your schedule.',
  webhook: 'The routine will run whenever its webhook is called.',
  manual: 'Press Run now whenever you want it to run.'
}

/** The new-routine side card: the three steps, in the place Recent runs takes once the routine exists. */
/** What still stops a save, at the top of the side column: the header's Save stays off until the list is empty. */
export function ProblemsCard({ errors }: { errors: string[] }) {
  return (
    <section className="rt-card rt-problems" data-testid="routine-problems">
      <CardHead icon="alert" title="Before you save" subtitle="Save turns on once these are fixed." />
      <ul className="rt-errors" data-testid="routine-errors">
        {errors.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>
    </section>
  )
}

export function HowItWorks({ triggerKind }: { triggerKind: RoutineDraft['triggerKind'] }) {
  const steps = [
    ['Set a trigger', 'Choose when this routine should run.'],
    ['Pick an agent and prompt', 'Select the agent, chat behavior, and what to send.'],
    ['Save and run', RUNS[triggerKind]]
  ]
  return (
    <section className="rt-card" data-testid="how-it-works">
      <CardHead icon="bulb" title="How it works" subtitle="" />
      <ol className="rt-steps">
        {steps.map(([title, text], i) => (
          <li key={title}>
            <span className="rt-num-dot">{i + 1}</span>
            <div>
              <div className="rt-step-title">{title}</div>
              <div className="rt-sub">{text}</div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}
