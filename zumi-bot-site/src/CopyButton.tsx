import { useEffect, useRef, useState } from 'react'
import { Glyph } from './Glyph.tsx'

/**
 * Copies `text`. Where the browser refuses (no clipboard, or no permission in an embedded view) it selects the element
 * `target` instead, so the reader's own copy shortcut finishes the job; the label says which happened.
 */
export function CopyButton({ text, label, target, className = 'btn xs term-copy' }: { text: string; label: string; target: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle')
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = () => {
    const done = (s: 'done' | 'failed') => {
      setState(s)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setState('idle'), 1800)
    }
    const fallback = () => {
      const el = document.getElementById(target)
      if (el) window.getSelection()?.selectAllChildren(el)
      done('failed')
    }
    if (!navigator.clipboard) return fallback()
    navigator.clipboard.writeText(text).then(() => done('done'), fallback)
  }
  return (
    <button type="button" className={className} onClick={copy} aria-label={`Copy: ${label}`}>
      <Glyph name={state === 'done' ? 'check' : 'copy'} size={13} weight={2} />
      <span aria-live="polite">{state === 'done' ? 'Copied' : state === 'failed' ? 'Selected, copy it' : 'Copy'}</span>
    </button>
  )
}
