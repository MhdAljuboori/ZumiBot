import { useContext, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ExtraProps } from 'react-markdown'
import { visibleText } from '@zumibot/shared/visibleText'
import { stateLabel } from '../state/processes'
import { latestRun, needsRunConfirm, runnableOfPre } from '../state/runBlocks'
import { ConfirmDialog } from './ConfirmDialog'
import { CheckIcon, CopyIcon } from './MessageActions'
import { RunBlockScope, RunLinkContext, type RunLink } from './runLink'

/** Copies a block's text, with a check for a moment after. */
export function CopyCodeButton({ text }: { text: () => string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])

  const copy = () =>
    void navigator.clipboard.writeText(text()).then(
      () => setCopied(true),
      () => setCopied(false)
    )
  return (
    <button
      type="button"
      className="code-copy"
      data-testid="code-copy"
      aria-label={copied ? 'Copied' : 'Copy code'}
      data-tip={copied ? 'Copied' : 'Copy code'}
      onClick={copy}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  )
}

function RunIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5 3.25v9.5L12.75 8z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * A runnable block: the code, then its latest run's status, Run and Copy. A refused run's sentence goes under the block,
 * outside it, so the block keeps one fill whether its tools sit beside the code or wrap under it.
 */
function RunBlock({
  link,
  chatId,
  messageId,
  command,
  copyText,
  children
}: {
  link: RunLink
  chatId: string
  messageId: string
  command: string
  copyText: () => string
  children: ReactNode
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  // Set at once, not on the next render, so a double click starts one run.
  const sending = useRef(false)
  const last = latestRun(link.list, messageId, command)
  const status = last === null ? null : stateLabel(last)

  const start = (): void => {
    if (sending.current) return
    sending.current = true
    setPending(true)
    void link
      .run(chatId, messageId, command)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        sending.current = false
        setPending(false)
      })
  }

  return (
    <>
      <div className="code-block runnable">
        {children}
        <div className="code-tools">
          {last !== null && status !== null && (
            <button
              type="button"
              className="code-run-status"
              data-testid="code-run-status"
              data-tone={status.tone}
              aria-label={`${status.text}: open its log`}
              data-tip="Open its log"
              onClick={() => link.open(chatId, last.id)}
            >
              <span className={`process-dot ${status.tone}`} aria-hidden="true" />
              {status.text} ›
            </button>
          )}
          <button
            type="button"
            className="code-run"
            data-testid="code-run"
            aria-label="Run command"
            data-tip="Run in the chat folder"
            disabled={pending}
            onClick={() => {
              setError(null)
              if (needsRunConfirm(command)) setAsking(true)
              else start()
            }}
          >
            <RunIcon />
          </button>
          <CopyCodeButton text={copyText} />
        </div>
      </div>
      {error !== null && (
        <span className="code-run-error" data-testid="code-run-error" role="alert">
          {error}
        </span>
      )}
      {/* On <body>: inside the reply, its Markdown styles would reach the dialog's text. */}
      {asking &&
        createPortal(
          <ConfirmDialog
            title="Run this command?"
            message="It holds characters that don't show on screen. They are spelled out below."
            detail={visibleText(command)}
            buttons={[
              { label: 'Run', value: 'run' },
              { label: 'Cancel', value: 'cancel' }
            ]}
            initialFocus="cancel"
            onResolve={(v) => {
              setAsking(false)
              if (v === 'run') start()
            }}
          />,
          document.body
        )}
    </>
  )
}

/** A code block, with a button that copies its text; a one-line shell block in a finished reply also runs. */
export function CodeBlock({ node, ...props }: ComponentProps<'pre'> & ExtraProps) {
  const pre = useRef<HTMLPreElement>(null)
  const scope = useContext(RunBlockScope)
  const link = useContext(RunLinkContext)
  const command = scope && link ? runnableOfPre(node) : null
  // The parser ends a block's text with a newline the agent did not write.
  const text = (): string => (pre.current?.textContent ?? '').replace(/\n$/, '')
  const code = <pre ref={pre} {...props} />
  if (scope && link && command !== null) {
    return (
      <RunBlock link={link} chatId={scope.chatId} messageId={scope.messageId} command={command} copyText={text}>
        {code}
      </RunBlock>
    )
  }
  return (
    <div className="code-block">
      {code}
      <CopyCodeButton text={text} />
    </div>
  )
}
