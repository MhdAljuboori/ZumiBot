import { pausingLine } from '../state/pause'

/** Over the composer while a pause waits for the reply to wrap up. Stop stays available beside the input. */
export function PausingLine({ running }: { running: number }) {
  return (
    <div className="pausing-line" role="status" aria-live="polite" data-testid="pausing-line">
      <span className="spinner" aria-hidden="true" />
      <span>{pausingLine(running)}</span>
    </div>
  )
}
