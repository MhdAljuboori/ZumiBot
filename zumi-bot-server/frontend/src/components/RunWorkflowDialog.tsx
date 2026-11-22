import { useEffect, useState } from 'react'
import { isEventKind } from '@zumibot/shared/workflowEvents'
import { TRIGGER_BODY_MAX, type WorkflowTrigger } from '@zumibot/shared/workflows'

interface Props {
  trigger: WorkflowTrigger['kind']
  /** A webhook workflow with a test call runs with that call, so it takes no typed input. */
  hasSample: boolean
  /** Unsaved edits (or a workflow never saved) go to the server first: the saved workflow is what runs. */
  willSave: boolean
  problems: number
  initialInput: string
  onRun: (input: string) => void
  onClose: () => void
}

/** Run workflow: an optional Input that becomes the trigger's output, then a run by hand. */
export function RunWorkflowDialog({ trigger, hasSample, willSave, problems, initialInput, onRun, onClose }: Props) {
  const [input, setInput] = useState(initialInput)
  const usesSample = trigger === 'webhook' && hasSample
  const blocked = problems > 0
  const run = (): void => {
    if (!blocked) onRun(usesSample ? '' : input)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wf-run-dialog" role="dialog" aria-modal="true" aria-labelledby="wf-run-title" data-testid="wf-run-dialog">
        <h2 id="wf-run-title" className="modal-title">
          Run workflow
        </h2>
        {usesSample ? (
          <p className="modal-message">It runs with the webhook's latest test call, as if that call came in now.</p>
        ) : (
          <label className="rt-fieldset">
            <span className="rt-label">Input (optional)</span>
            <textarea
              className="rt-input"
              data-testid="wf-run-input"
              rows={5}
              maxLength={TRIGGER_BODY_MAX}
              autoFocus
              placeholder={
                trigger === 'webhook'
                  ? 'No test call yet: this text is what the trigger hands on.'
                  : 'What the trigger hands on as {{trigger.text}}'
              }
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  run()
                }
              }}
            />
          </label>
        )}
        {isEventKind(trigger) && (
          <p className="rt-hint" data-testid="wf-run-event-hint">
            A run by hand hands on only this text; trigger.body fields stay empty.
          </p>
        )}
        {willSave && !blocked && <p className="rt-hint">Your unsaved changes are saved first.</p>}
        {blocked && (
          <p className="rt-hint rt-bad" role="alert">
            This workflow has problems: fix them before running.
          </p>
        )}
        <div className="modal-buttons wf-run-buttons">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            data-testid="wf-run-confirm"
            disabled={blocked}
            autoFocus={usesSample}
            onClick={run}
          >
            Run
          </button>
        </div>
      </div>
    </div>
  )
}
