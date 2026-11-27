import { useId } from 'react'

/**
 * The suggested replies, in the thread under the reply that asked: what the reply did, the question it asks, and the
 * answers as buttons.
 * A click sends that button's text as the user's own message.
 */
export function ReplyOptions({
  options,
  question,
  summary,
  disabled,
  onPick
}: {
  options: string[]
  question?: string
  summary?: string
  disabled: boolean
  onPick(text: string): void
}) {
  const questionId = useId()
  return (
    <div className="reply-options" data-testid="reply-options">
      <section className="reply-options-card" aria-label="Suggested replies">
        {summary && (
          <p className="reply-options-summary" data-testid="reply-options-summary">
            {summary}
          </p>
        )}
        {question && (
          <p className="reply-options-question" id={questionId} data-testid="reply-options-question">
            {question}
          </p>
        )}
        <div className="reply-options-row" role="group" {...(question ? { 'aria-labelledby': questionId } : { 'aria-label': 'Answers' })}>
          {options.map((o) => (
            <button key={o} type="button" className="reply-option" data-testid="reply-option" disabled={disabled} onClick={() => onPick(o)}>
              {o}
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}
