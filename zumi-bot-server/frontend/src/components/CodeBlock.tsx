import { useEffect, useRef, useState, type ComponentProps } from 'react'
import type { ExtraProps } from 'react-markdown'
import { CheckIcon, CopyIcon } from './MessageActions'

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

/** A code block, with a button that copies its text. */
export function CodeBlock({ node: _node, ...props }: ComponentProps<'pre'> & ExtraProps) {
  const pre = useRef<HTMLPreElement>(null)
  return (
    <div className="code-block">
      <pre ref={pre} {...props} />
      {/* The parser ends a block's text with a newline the agent did not write. */}
      <CopyCodeButton text={() => (pre.current?.textContent ?? '').replace(/\n$/, '')} />
    </div>
  )
}
