import { useMemo, useState } from 'react'
import type { WorkflowLink } from '@zumibot/shared/types'
import { foldText } from '../state/auditLog'
import { inputLabel, materialMarkdown, type PromptPart } from '../state/workflowMessage'
import { Markdown } from './Markdown'
import { UserText, type UserMentions } from './UserText'

/**
 * A workflow step's message: its own text as the user bubble draws it, and each `<input>` block as a labelled box. The
 * material came from a model, a webhook or another agent, so it is only drawn through Markdown (which never takes raw
 * HTML), as the run view does.
 */
export function WorkflowPrompt({
  parts,
  link,
  mentions,
  from
}: {
  parts: PromptPart[]
  link: WorkflowLink | undefined
  mentions: UserMentions | null
  from?: string
}) {
  return (
    <div className="bubble user wf-prompt" data-testid="wf-prompt" {...(from ? { 'data-from': from } : {})}>
      {parts.map((p, i) =>
        p.kind === 'text' ? (
          <UserText key={i} text={p.text} mentions={mentions} />
        ) : (
          <InputBox key={i} label={inputLabel(p.from, link)} text={p.text} />
        )
      )}
    </div>
  )
}

function InputBox({ label, text }: { label: string; text: string }) {
  const [all, setAll] = useState(false)
  const blank = text.trim() === ''
  const fold = useMemo(() => (blank ? null : foldText(text)), [text, blank])
  const folded = fold !== null && fold.more && !all
  // A preview renders live, as in the audit log: one cut inside a fence stays code until Show all.
  return (
    <section className="wf-prompt-input" data-testid="wf-prompt-input" aria-label={`Input from ${label}`}>
      <div className="wf-prompt-input-head">
        <span className="wf-prompt-input-tag">Input</span>
        <span className="wf-prompt-input-from" data-testid="wf-prompt-input-from">
          {label}
        </span>
      </div>
      {blank ? (
        <span className="wf-prompt-input-empty">Empty.</span>
      ) : (
        <div className={`wf-prompt-input-text${folded ? ' folded' : ''}`}>
          <Markdown text={materialMarkdown(text, folded && fold ? fold.preview : text)} live={folded} />
        </div>
      )}
      {fold?.more && (
        <button
          type="button"
          className="wf-prompt-input-more"
          data-testid="wf-prompt-input-more"
          aria-expanded={all}
          onClick={() => setAll((a) => !a)}
        >
          {all ? 'Show less' : 'Show all'}
        </button>
      )}
    </section>
  )
}
