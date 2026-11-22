import { useEffect, useState } from 'react'
import type { WebhookCall } from '@zumibot/shared/routines'
import { fieldList } from '@zumibot/shared/routineFields'
import { ConfirmDialog } from './ConfirmDialog'

interface Props {
  /** Null while the URL and secret are being made. */
  hook: { url: string; secret: string } | null
  error: string | null
  latest: WebhookCall | null
  checking: boolean
  onCheck: () => void
  onNewSecret: () => void
  /** Called with a field path such as `body.pr.title`. */
  onInsert: (path: string) => void
  /** The field rows' button; a workflow's trigger has no prompt to insert into, so it adds a filter instead. */
  insertLabel?: string
}

function CopyButton({ text, testId, label = 'Copy' }: { text: string; testId: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  // A new secret is a new thing to copy.
  useEffect(() => setCopied(false), [text])
  return (
    <button
      type="button"
      className="btn small"
      data-testid={testId}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(
          () => setCopied(true),
          () => setCopied(false)
        )
      }
    >
      {copied ? 'Copied' : label}
    </button>
  )
}

export function WebhookPanel({ hook, error, latest, checking, onCheck, onNewSecret, onInsert, insertLabel = 'Insert' }: Props) {
  const [shown, setShown] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const fields = latest ? fieldList(latest) : []
  if (!hook) {
    return (
      <div className="rt-hook" data-testid="webhook-panel">
        <div className="rt-hint">{error ?? 'Making the webhook URL…'}</div>
      </div>
    )
  }
  return (
    <div className="rt-hook" data-testid="webhook-panel">
      <div className="rt-label">URL</div>
      <div className="rt-kv">
        <span className="rt-field mono" data-testid="webhook-url">
          {hook.url}
        </span>
        <CopyButton text={hook.url} testId="webhook-url-copy" />
      </div>
      <div className="rt-label">Secret</div>
      <div className="rt-kv rt-kv-secret">
        <span className="rt-field mono" data-testid="webhook-secret">
          {shown ? hook.secret : '•'.repeat(24)}
        </span>
        <button type="button" className="btn small" data-testid="webhook-secret-show" onClick={() => setShown((v) => !v)}>
          {shown ? 'Hide' : 'Show'}
        </button>
        <CopyButton text={hook.secret} testId="webhook-secret-copy" />
        <button type="button" className="btn small rt-new-secret" data-testid="webhook-new-secret" onClick={() => setConfirming(true)}>
          New secret
        </button>
      </div>
      <div className="rt-hint rt-hook-how">
        Send it as the <span className="mono">X-ZumiBot-Secret</span> header. Any method works: GET data comes from the URL's query, other
        methods from the body (JSON or form).
      </div>
      {error && (
        <div className="rt-hint rt-bad" role="alert">
          {error}
        </div>
      )}
      {latest === null ? (
        <div className="rt-wait" data-testid="webhook-waiting">
          <div className="rt-grow">No test call yet. Call the URL from your tool, then check.</div>
          <button type="button" className="btn primary" data-testid="webhook-check" disabled={checking} onClick={onCheck}>
            Check test call
          </button>
        </div>
      ) : (
        <div className="rt-got" data-testid="webhook-latest">
          <div className="rt-got-head">
            <span className="rt-method" data-testid="webhook-method">
              {latest.method}
            </span>
            <span>Test call · {new Date(latest.receivedAt).toLocaleString()}</span>
            <span className="rt-grow" />
            <button type="button" className="btn small" data-testid="webhook-check" disabled={checking} onClick={onCheck}>
              Check again
            </button>
          </div>
          {fields.length === 0 && <div className="rt-frow rt-hint">The test call had no fields.</div>}
          {fields.map((f) => (
            <div key={f.path} className="rt-frow" data-testid="webhook-field" data-path={f.path}>
              <span className="rt-fk mono">{f.path}</span>
              <span className="rt-fv">{f.sample}</span>
              <button type="button" className="rt-insert" onClick={() => onInsert(f.path)}>
                {insertLabel}
              </button>
            </div>
          ))}
        </div>
      )}
      {confirming && (
        <ConfirmDialog
          title="Make a new secret?"
          message="The old secret stops working at once. Update the tool that calls this URL."
          buttons={[
            { label: 'New secret', value: 'ok', danger: true },
            { label: 'Cancel', value: 'cancel' }
          ]}
          initialFocus="cancel"
          onResolve={(v) => {
            setConfirming(false)
            if (v === 'ok') {
              setShown(false)
              onNewSecret()
            }
          }}
        />
      )}
    </div>
  )
}
