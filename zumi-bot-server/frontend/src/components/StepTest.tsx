import { useEffect, useRef, useState } from 'react'
import type { Port, Step, WorkflowInput, WorkflowRunSummary } from '@zumibot/shared/workflows'
import { api } from '../api'
import { errorMessage } from '../errors'
import { getRun } from '../net/useWorkflows'
import { newestStepInput } from '../state/workflowEditor'
import { ExpandButton, ExpandDialog } from './ExpandDialog'

// The server's cap on a test input (TEST_INPUT_MAX in handlers.ts): a step's input may join several steps' outputs.
const TEST_INPUT_MAX = 200_000
const PORT_WORDS: Partial<Record<Port, string>> = { yes: 'Yes', no: 'No' }

type Result = { output?: string; port?: Port; reason?: string; chatId?: string; error?: string; missing?: string[] }

interface Props {
  draft: WorkflowInput
  step: Step
  /** This workflow's run summaries: the newest run that reached the step gives the starting input. */
  runs: WorkflowRunSummary[]
  onOpenChat: (chatId: string) => void
}

/**
 * Run step: tests one LLM, Condition, Agent, For each, HTTP request or Transform step with the editor's unsaved draft, so the user tests what they see.
 * Nothing is stored as a run. Mounted per step (the inspector is keyed by step), so its input and result never leak
 * to another step.
 */
export function StepTest({ draft, step, runs, onOpenChat }: Props) {
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const touched = useRef(false)
  const unmounted = useRef(false)
  const runsRef = useRef(runs)
  runsRef.current = runs
  // The input or the output open in an ExpandDialog, and the button that opened it, which gets focus back.
  const [big, setBig] = useState<'input' | 'output' | null>(null)
  const inputOpener = useRef<HTMLButtonElement>(null)
  const outputOpener = useRef<HTMLButtonElement>(null)
  const closeBig = (): void => {
    const opener = big === 'input' ? inputOpener : outputOpener
    setBig(null)
    opener.current?.focus()
  }
  const type = (text: string): void => {
    touched.current = true
    setInput(text)
  }

  useEffect(() => {
    unmounted.current = false
    // Read once per step: typing first wins over a late answer.
    void newestStepInput(runsRef.current, step.id, getRun).then((text) => {
      if (!unmounted.current && !touched.current && text !== null) setInput(text)
    })
    return () => {
      unmounted.current = true
    }
  }, [step.id])

  const run = (): void => {
    setRunning(true)
    setResult(null)
    api.workflows
      .testStep(draft, step.id, input)
      .then(
        (r) => {
          if (!unmounted.current) setResult(r)
        },
        (e: unknown) => {
          if (!unmounted.current) setResult({ error: errorMessage(e) })
        }
      )
      .finally(() => {
        if (!unmounted.current) setRunning(false)
      })
  }

  return (
    <section className="wf-test" data-testid="wf-test-section">
      <div className="wf-field-head">
        <div className="rt-label">Run step</div>
        <ExpandButton ref={inputOpener} label="Test input" testId="wf-test-input-expand" onClick={() => setBig('input')} />
      </div>
      <textarea
        className="rt-input wf-test-input"
        data-testid="wf-test-input"
        aria-label="Test input"
        rows={4}
        maxLength={TEST_INPUT_MAX}
        placeholder="The input this step gets. Filled from its latest run when there is one."
        value={input}
        onChange={(e) => type(e.target.value)}
      />
      {(step.kind === 'agent' || step.kind === 'foreach') && (
        <div className="rt-hint" data-testid="wf-test-real">
          This makes a real chat with the agent, in its folder.
        </div>
      )}
      {step.kind === 'foreach' && (
        <div className="rt-hint" data-testid="wf-test-first">
          Runs the first item only.
        </div>
      )}
      {step.kind === 'http' && (
        <div className="rt-hint" data-testid="wf-test-real">
          This sends the request for real.
        </div>
      )}
      <div className="wf-test-row">
        <button type="button" className="btn" data-testid="wf-test" disabled={running} onClick={run}>
          {running ? 'Running…' : 'Run step'}
        </button>
        {running && <span className="spinner" aria-hidden="true" />}
      </div>
      {result && (
        <div className="wf-test-result" data-testid="wf-test-result" role="status">
          {result.error && <div className="rt-hint rt-bad">{result.error}</div>}
          {result.missing && result.missing.length > 0 && (
            <div className="rt-hint" data-testid="wf-test-missing">
              Missing fields: {result.missing.join(', ')}
            </div>
          )}
          {result.port && (
            <div className="wf-test-answer">
              Answer: <strong>{PORT_WORDS[result.port] ?? result.port}</strong>
            </div>
          )}
          {result.reason && <div className="wf-test-reason">{result.reason}</div>}
          {result.output !== undefined &&
            step.kind !== 'condition' &&
            (result.output === '' ? (
              <div className="rt-hint">No output.</div>
            ) : (
              <div className="wf-test-output-wrap">
                <pre className="wf-test-output" data-testid="wf-test-output">
                  {result.output}
                </pre>
                <ExpandButton ref={outputOpener} label="Output" testId="wf-test-output-expand" onClick={() => setBig('output')} />
              </div>
            ))}
          {result.chatId && (
            <button type="button" className="rt-insert" data-testid="wf-test-open-chat" onClick={() => onOpenChat(result.chatId as string)}>
              Open chat
            </button>
          )}
        </div>
      )}
      {big === 'input' && (
        <ExpandDialog title="Test input" testId="wf-test-input-dialog" onClose={closeBig}>
          <textarea
            className="rt-input wf-expand-text"
            data-testid="wf-test-input-big"
            aria-label="Test input"
            maxLength={TEST_INPUT_MAX}
            autoFocus
            placeholder="The input this step gets. Filled from its latest run when there is one."
            value={input}
            onChange={(e) => type(e.target.value)}
          />
        </ExpandDialog>
      )}
      {big === 'output' && result?.output && (
        <ExpandDialog title="Output" testId="wf-test-output-dialog" onClose={closeBig}>
          <pre className="wf-test-output wf-expand-pre" data-testid="wf-test-output-big" tabIndex={0} autoFocus>
            {result.output}
          </pre>
        </ExpandDialog>
      )}
    </section>
  )
}
