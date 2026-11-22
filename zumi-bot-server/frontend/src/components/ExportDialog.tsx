import { useEffect, useRef, useState } from 'react'
import { exportFileName, type ExportFormat, type ExportOptions } from '@zumibot/shared/chatExport'
import type { ChatMeta } from '@zumibot/shared/types'
import { nextTrapIndex } from '../net/folderPicker'
import { copyPending, EXPORT_MIME, ExportError, fetchExport, pageZone, saveText } from '../net/chatExport'

interface Props {
  chat: Pick<ChatMeta, 'id' | 'title'>
  /** The agent message it was opened from: offers that reply alone. Null = the whole chat only. */
  item: string | null
  onClose: () => void
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled)'

const FORMATS: { value: ExportFormat; title: string; sub: string }[] = [
  { value: 'md', title: 'Markdown', sub: 'A .md file for GitHub, notes or docs.' },
  { value: 'html', title: 'Web page', sub: 'A .html file anyone can open in a browser.' }
]

/** Export: the chat, or one reply of it, as Markdown or a self-contained web page, to download or copy. */
export function ExportDialog({ chat, item, onClose }: Props) {
  const [format, setFormat] = useState<ExportFormat>('md')
  const [steps, setSteps] = useState(false)
  const [reply, setReply] = useState(item !== null)
  const [busy, setBusy] = useState<'download' | 'copy' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const dialog = useRef<HTMLDivElement>(null)

  const options = (f: ExportFormat): ExportOptions => ({ format: f, steps, item: reply ? item : null, timeZone: pageZone() })

  const download = (): void => {
    if (busy) return
    setBusy('download')
    setError(null)
    fetchExport(chat.id, options(format)).then(
      (text) => {
        saveText(exportFileName(chat.title, format, reply && item !== null), text, EXPORT_MIME[format])
        onClose()
      },
      (e: unknown) => {
        setBusy(null)
        setError(e instanceof ExportError ? e.message : 'Export failed. Try again.')
      }
    )
  }

  // Always Markdown: it pastes well into chat apps, issues and docs, where HTML source would not.
  const copy = (): void => {
    if (busy) return
    setBusy('copy')
    setError(null)
    setCopied(false)
    copyPending(fetchExport(chat.id, options('md'))).then(
      () => {
        setBusy(null)
        setCopied(true)
      },
      (e: unknown) => {
        setBusy(null)
        // Anything but the export's own failure is the clipboard refusing.
        setError(e instanceof ExportError ? e.message : 'Could not copy. Download it instead.')
      }
    )
  }

  const keys = useRef({ onClose, download })
  keys.current = { onClose, download }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing) return
      if (e.key === 'Escape') {
        e.preventDefault()
        keys.current.onClose()
      } else if (e.key === 'Tab') {
        const els = Array.from(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
        const to = nextTrapIndex(els.length, els.indexOf(document.activeElement as HTMLElement), e.shiftKey)
        if (to !== null) {
          e.preventDefault()
          els[to].focus()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>('[data-testid="export-download"]')?.focus()
  }, [])

  return (
    <div className="modal-backdrop export-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialog}
        tabIndex={-1}
        className="modal export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-title"
        aria-busy={busy !== null}
        data-testid="export-dialog"
      >
        <h2 id="export-title" className="modal-title">
          {item !== null ? 'Export reply' : 'Export chat'}
        </h2>
        <p className="export-for" dir="auto">
          {chat.title}
        </p>

        {item !== null && (
          <div className="export-scope" role="radiogroup" aria-label="What to export">
            <label>
              <input
                type="radio"
                name="export-scope"
                data-testid="export-scope-reply"
                checked={reply}
                disabled={busy !== null}
                onChange={() => setReply(true)}
              />
              This reply
            </label>
            <label>
              <input
                type="radio"
                name="export-scope"
                data-testid="export-scope-chat"
                checked={!reply}
                disabled={busy !== null}
                onChange={() => setReply(false)}
              />
              Whole chat
            </label>
          </div>
        )}

        <div className="clone-options export-formats" role="radiogroup" aria-label="Format">
          {FORMATS.map((f) => (
            <button
              key={f.value}
              type="button"
              role="radio"
              className="clone-option"
              data-testid={`export-format-${f.value}`}
              aria-checked={format === f.value}
              aria-pressed={format === f.value}
              disabled={busy !== null}
              onClick={() => setFormat(f.value)}
            >
              <span className="clone-option-title">{f.title}</span>
              <span className="clone-option-sub">{f.sub}</span>
            </button>
          ))}
        </div>

        <label className="export-check">
          <input
            type="checkbox"
            data-testid="export-steps"
            checked={steps}
            disabled={busy !== null}
            onChange={(e) => setSteps(e.target.checked)}
          />
          Include tool steps and errors
        </label>
        <p className="clone-hint">
          Messages, answered questions and plans are always in. Side questions, to-dos and the chat's folder are not.
        </p>

        {error !== null && (
          <p className="clone-error" role="alert" data-testid="export-error">
            {error}
          </p>
        )}

        <div className="modal-buttons clone-buttons">
          <button type="button" className="btn" data-testid="export-copy" disabled={busy !== null} onClick={copy}>
            {busy === 'copy' ? 'Copying…' : copied ? 'Copied' : 'Copy Markdown'}
          </button>
          <span className="modal-spacer" />
          <button type="button" className="btn" data-testid="export-cancel" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" data-testid="export-download" disabled={busy !== null} onClick={download}>
            {busy === 'download' ? 'Exporting…' : 'Download'}
          </button>
        </div>
      </div>
    </div>
  )
}
