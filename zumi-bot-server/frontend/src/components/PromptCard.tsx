import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { forTextarea } from '../state/editorState'
import { EditorIcon } from './EditorIcon'

const TEMPLATE = '# Role\nYou are …\n\n# Context\n- \n\n# Instructions\n1. \n\n# Output\nWhat the final report should contain.\n'

interface Props {
  fileName: string
  body: string
  onBody: (body: string) => void
  /** A fixed note under the heading (a remote agent's instructions are not sent), or null. */
  note?: string | null
}

export function PromptCard({ fileName, body, onBody, note = null }: Props) {
  const input = useRef<HTMLTextAreaElement>(null)
  const [copied, setCopied] = useState(false)
  const text = forTextarea(body)
  const lines = text.split('\n')

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(id)
  }, [copied])

  const insertTemplate = (): void => {
    const el = input.current
    if (!el) return
    const before = el.value.slice(0, el.selectionStart)
    const gap = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
    el.focus()
    // insertText keeps the textarea's undo history and fires the input event React listens to.
    if (!document.execCommand('insertText', false, gap + TEMPLATE)) {
      onBody(before + gap + TEMPLATE + el.value.slice(el.selectionEnd))
    }
  }

  // The gutter fits the widest line number; at least two digits so it doesn't jump at line 10.
  const gutter = { '--gutter': `calc(${Math.max(2, String(lines.length).length)}ch + 28px)` } as CSSProperties

  return (
    <section className="card prompt-card" aria-labelledby="card-prompt">
      <header className="card-head">
        <EditorIcon name="terminal" />
        <h3 className="card-title" id="card-prompt">
          System prompt
        </h3>
        <div className="card-actions">
          <button type="button" className="btn small" onClick={insertTemplate}>
            <EditorIcon name="wand" />
            Insert template
          </button>
          <button
            type="button"
            className="btn small"
            onClick={() =>
              void navigator.clipboard.writeText(text).then(
                () => setCopied(true),
                () => setCopied(false)
              )
            }
          >
            <EditorIcon name={copied ? 'check' : 'copy'} />
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </header>

      {note !== null && (
        <p className="card-note" role="status" data-testid="prompt-note">
          {note}
        </p>
      )}

      <div className="code-box">
        <div className="code-titlebar">
          <span className="code-file">{fileName}</span>
          <span className="grow" />
          <span>Markdown</span>
        </div>
        {/* The textarea sits over a hidden copy of its text that wraps the same way, so each number lines up with its line. */}
        <div className="code-scroll">
          <div className="code-content" style={gutter}>
            <div className="code-lines" aria-hidden="true">
              {lines.map((line, i) => (
                <div key={i} className="code-line">
                  <span className="code-no">{i + 1}</span>
                  <span className="code-text">{line || ' '}</span>
                </div>
              ))}
            </div>
            <textarea
              id="agent-prompt"
              ref={input}
              className="code-input"
              aria-labelledby="card-prompt"
              spellCheck={false}
              value={text}
              onChange={(e) => onBody(e.target.value)}
            />
          </div>
        </div>
        <div className="code-foot">
          <span>
            Lines: <b>{lines.length}</b>
          </span>
          <span>
            Characters: <b>{text.length}</b>
          </span>
        </div>
      </div>
    </section>
  )
}
