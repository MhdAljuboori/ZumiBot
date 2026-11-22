import { useState, type ReactNode } from 'react'
import { FEEDBACK_MAX_CHARS } from '@zumibot/shared/plans'
import { isActionable, type ApprovalItem, type ApprovalReply } from '../state/approvals'
import { cancelFeedback, EMPTY_PLAN_DRAFT, openFeedback, planLine, planReply, planView, typeFeedback, type PlanDraft } from '../state/plans'
import { Markdown } from './Markdown'

interface Props {
  item: ApprovalItem
  chatRunning: boolean
  onAnswer: (requestId: string, reply: ApprovalReply) => void
  /** Drawn right under the plan text (the Inbox's Show full plan, over a plan it folds). */
  planMore?: ReactNode
}

export function PlanCard({ item, chatRunning, onAnswer, planMore }: Props) {
  // Component state, not derived from the item: delta pushes re-render the list but keep this card's key, so a typed note survives.
  const [draft, setDraft] = useState<PlanDraft>(EMPTY_PLAN_DRAFT)
  const actionable = isActionable(item, chatRunning)
  const { heading, plan, planFilePath } = planView(item)
  const muted = item.status !== 'approved' && item.status !== 'sent-back'

  return (
    <div
      className={`approval plan ${actionable ? 'pending' : 'done'}`}
      data-testid="plan-card"
      data-status={item.status}
      data-request-id={item.id}
    >
      <div className="plan-head">{heading}</div>
      {plan !== null ? (
        // Focusable so a keyboard user can scroll a long plan.
        <div className="plan-body" tabIndex={0} data-testid="plan-body">
          <Markdown text={plan} />
        </div>
      ) : (
        <div className="plan-missing" data-testid="plan-missing">
          No plan text was sent.
          {planFilePath !== null && <code className="plan-path">{planFilePath}</code>}
        </div>
      )}
      {plan !== null && planMore}
      {plan !== null && planFilePath !== null && (
        <div className="plan-path-row">
          Saved at <code className="plan-path">{planFilePath}</code>
        </div>
      )}
      {!actionable && item.status === 'sent-back' && item.feedback && (
        <blockquote className="plan-feedback" data-testid="plan-feedback">
          {item.feedback}
        </blockquote>
      )}
      {actionable ? (
        draft.open ? (
          <div className="plan-feedback-form">
            <textarea
              className="question-other-input plan-feedback-input"
              data-testid="plan-feedback-input"
              rows={3}
              maxLength={FEEDBACK_MAX_CHARS}
              autoFocus
              placeholder="What should change? (optional)"
              value={draft.feedback}
              onChange={(e) => setDraft(typeFeedback(draft, e.target.value))}
            />
            <div className="approval-actions">
              <button type="button" className="btn" data-testid="plan-send" onClick={() => onAnswer(item.id, planReply(false, draft))}>
                Send
              </button>
              <button type="button" className="btn" data-testid="plan-cancel" onClick={() => setDraft(cancelFeedback(draft))}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="approval-actions">
            <button
              type="button"
              className="btn primary"
              data-testid="plan-approve"
              onClick={() => onAnswer(item.id, planReply(true, draft))}
            >
              Approve
            </button>
            <button type="button" className="btn" data-testid="plan-keep" onClick={() => setDraft(openFeedback(draft))}>
              Keep planning
            </button>
          </div>
        )
      ) : (
        <div className={muted ? 'approval-line muted' : 'approval-line'}>{planLine(item)}</div>
      )}
    </div>
  )
}
