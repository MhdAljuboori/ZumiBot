import { useState, type KeyboardEvent } from 'react'
import { parseQuestions, questionHeading, type Question, type QuestionOption } from '@zumibot/shared/questions'
import { approvalLine, isActionable, type ApprovalItem, type ApprovalReply } from '../state/approvals'
import {
  answerOf,
  buildAnswers,
  choose,
  chooseOther,
  enterAction,
  goTo,
  questionMarkdown,
  shownAnswer,
  typeOther,
  EMPTY_DRAFT,
  type Draft,
  type QuestionPick
} from '../state/questions'
import { coarsePointer } from '../media'
import { Markdown } from './Markdown'

interface Props {
  item: ApprovalItem
  chatRunning: boolean
  onAnswer: (requestId: string, reply: ApprovalReply) => void
}

const pickLabel = (q: Question, i: number): string => (q.header !== '' ? q.header : `Question ${i + 1}`)

const QuestionIcon = () => (
  <span className="question-icon" aria-hidden="true">
    ?
  </span>
)

// A status this muted; 'answered' reads like a normal finished state, not a dimmed one.
const isMuted = (status: ApprovalItem['status']): boolean =>
  status === 'pending' || status === 'unanswered' || status === 'denied' || status === 'skipped'

export function QuestionCard({ item, chatRunning, onAnswer }: Props) {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const actionable = isActionable(item, chatRunning)
  const parsed = parseQuestions(item.input)
  const line = approvalLine(item.status) ?? 'Not answered'
  const muted = isMuted(item.status)
  const cardClass = `approval question ${actionable ? 'pending' : 'done'}`

  if (!parsed) {
    return (
      <div className={cardClass} data-testid="question-card" data-status={item.status} data-request-id={item.id}>
        <div className="approval-desc">This question can&apos;t be shown.</div>
        {actionable ? (
          <div className="approval-actions">
            <button
              type="button"
              className="btn question-skip"
              data-testid="question-skip"
              onClick={() => onAnswer(item.id, { answers: null })}
            >
              Skip
            </button>
          </div>
        ) : (
          <div className={muted ? 'approval-line muted' : 'approval-line'}>{line}</div>
        )}
      </div>
    )
  }

  const { title, questions } = parsed
  const heading = questionHeading(title, questions.length, item.agent ?? null)

  if (!actionable) {
    return (
      <div className={cardClass} data-testid="question-card" data-status={item.status} data-request-id={item.id}>
        <div className="question-headrow">
          <QuestionIcon />
          <div className="question-head">{heading}</div>
        </div>
        {questions.map((q) => {
          const pick = shownAnswer(q, item.answers?.[q.text])
          return (
            <div key={q.text} className="question-block">
              {q.header !== '' && <div className="question-chip">{q.header}</div>}
              <div className="question-text">
                <Markdown text={questionMarkdown(q.text)} />
              </div>
              {q.description && (
                <div className="question-desc">
                  <Markdown text={questionMarkdown(q.description)} />
                </div>
              )}
              {q.options.map((opt) => {
                const selected = pick.labels.includes(opt.label)
                return (
                  <label
                    key={opt.label}
                    className={selected ? 'question-option on' : 'question-option dim'}
                    data-testid="question-option"
                    data-label={opt.label}
                  >
                    <input type={q.multiSelect ? 'checkbox' : 'radio'} checked={selected} disabled readOnly />
                    <span>
                      {opt.label}
                      {selected && opt.preview && <pre className="question-preview">{opt.preview}</pre>}
                    </span>
                  </label>
                )
              })}
              {pick.other !== null && (
                <div className="question-other-row on" data-testid="question-other">
                  <span>{pick.other}</span>
                </div>
              )}
            </div>
          )
        })}
        <div className={muted ? 'approval-line muted' : 'approval-line'}>{line}</div>
      </div>
    )
  }

  // Actively answerable: one question at a time (the mockup's layout B).
  const step = Math.min(draft.step, questions.length - 1)
  const q = questions[step]
  const pick: QuestionPick = draft.picks[q.text] ?? { labels: [], other: null }
  const otherActive = pick.other !== null
  const isLast = step === questions.length - 1
  const showNext = !isLast && (q.kind !== 'choice' || q.multiSelect || otherActive)
  const answers = buildAnswers(questions, draft)

  const onEnter = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    // Enter while an IME is composing picks the candidate; it must not send.
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    // As in the composer: Shift+Enter is a new line, and so is Enter on a touch keyboard (Ctrl/Cmd+Enter sends there).
    if (e.currentTarget.tagName === 'TEXTAREA' && (e.shiftKey || (coarsePointer() && !e.metaKey && !e.ctrlKey))) return
    e.preventDefault()
    const action = enterAction(draft, questions)
    if (action === 'next') setDraft(goTo(draft, questions, step + 1))
    else if (action === 'send' && answers) onAnswer(item.id, { answers })
  }

  const optionRow = (opt: QuestionOption) => {
    const selected = pick.labels.includes(opt.label)
    return (
      <label
        key={opt.label}
        className={selected ? 'question-option on' : 'question-option'}
        data-testid="question-option"
        data-label={opt.label}
      >
        <input
          type={q.multiSelect ? 'checkbox' : 'radio'}
          checked={selected}
          readOnly
          onClick={() => setDraft(choose(draft, questions, opt.label))}
        />
        <span>
          {opt.label}
          {opt.description && <small>{opt.description}</small>}
          {selected && opt.preview && <pre className="question-preview">{opt.preview}</pre>}
        </span>
      </label>
    )
  }

  const singleQuestion = questions.length === 1

  return (
    <div className={cardClass} data-testid="question-card" data-status={item.status} data-request-id={item.id}>
      <div className="question-headrow">
        <QuestionIcon />
        <div className="question-head">{heading}</div>
      </div>
      {!singleQuestion && (
        <div className="question-tabs">
          {questions.map((qq, i) => {
            const done = answerOf(qq, draft.picks[qq.text]) !== null
            return (
              <button
                key={qq.text}
                type="button"
                className={i === step ? 'question-tab on' : 'question-tab'}
                data-testid="question-tab"
                data-done={done}
                onClick={() => setDraft(goTo(draft, questions, i))}
              >
                {done ? `✓ ${pickLabel(qq, i)}` : pickLabel(qq, i)}
              </button>
            )
          })}
        </div>
      )}
      <div className="question-body">
        {singleQuestion && q.header !== '' && <div className="question-chip">{q.header}</div>}
        <div className="question-text">
          <Markdown text={questionMarkdown(q.text)} />
        </div>
        {q.description && (
          <div className="question-desc">
            <Markdown text={questionMarkdown(q.description)} />
          </div>
        )}
        {q.kind === 'choice' ? (
          <>
            {q.options.map(optionRow)}
            <div className="question-other-wrap">
              <label className={otherActive ? 'question-other-row on' : 'question-other-row'} data-testid="question-other">
                <input
                  type={q.multiSelect ? 'checkbox' : 'radio'}
                  checked={otherActive}
                  readOnly
                  onClick={() => setDraft(chooseOther(draft, questions))}
                />
                <span>Other</span>
              </label>
              {otherActive && (
                <textarea
                  className="question-other-input"
                  data-testid="question-other-input"
                  rows={2}
                  maxLength={8192}
                  placeholder="Type your own answer"
                  value={pick.other ?? ''}
                  onChange={(e) => setDraft(typeOther(draft, questions, e.target.value))}
                  onKeyDown={onEnter}
                />
              )}
            </div>
          </>
        ) : q.kind === 'number' ? (
          <div className="question-number-row">
            <input
              type="number"
              className="question-other-input"
              data-testid="question-other-input"
              min={q.min ?? undefined}
              max={q.max ?? undefined}
              step={q.step ?? undefined}
              placeholder={q.defaultValue !== null ? String(q.defaultValue) : undefined}
              value={pick.other ?? ''}
              onChange={(e) => setDraft(typeOther(draft, questions, e.target.value))}
              onKeyDown={onEnter}
            />
            {q.unit && <span className="question-unit">{q.unit}</span>}
          </div>
        ) : (
          <textarea
            className="question-other-input"
            data-testid="question-other-input"
            rows={2}
            maxLength={8192}
            placeholder={q.placeholder ?? 'Type your answer'}
            value={pick.other ?? ''}
            onChange={(e) => setDraft(typeOther(draft, questions, e.target.value))}
            onKeyDown={onEnter}
          />
        )}
      </div>
      <div className="question-footer">
        <span className="question-hint">
          Question {step + 1} of {questions.length}
        </span>
        {step > 0 && (
          <button
            type="button"
            className="btn question-back"
            data-testid="question-back"
            onClick={() => setDraft(goTo(draft, questions, step - 1))}
          >
            Back
          </button>
        )}
        <button
          type="button"
          className="btn question-skip"
          data-testid="question-skip"
          onClick={() => onAnswer(item.id, { answers: null })}
        >
          Skip
        </button>
        {showNext && (
          <button
            type="button"
            className="btn question-next"
            data-testid="question-next"
            onClick={() => setDraft(goTo(draft, questions, step + 1))}
          >
            Next
          </button>
        )}
        {isLast && (
          <button
            type="button"
            className="btn primary question-send"
            data-testid="question-send"
            disabled={answers === null}
            onClick={() => answers && onAnswer(item.id, { answers })}
          >
            Send answers
          </button>
        )}
      </div>
    </div>
  )
}
