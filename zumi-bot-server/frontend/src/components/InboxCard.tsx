import { useLayoutEffect, useRef, useState } from 'react'
import { PLAN_TOOL } from '@zumibot/shared/plans'
import { QUESTION_TOOL } from '@zumibot/shared/questions'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import { mentionLabel } from '../state/agentNames'
import { stepChoiceFor, type ApprovalReply } from '../state/approvals'
import { entryHeader, waitedText, type InboxAnswer, type WaitingEntry } from '../state/inbox'
import { findAgent, missingAgent } from '../state/groupChat'
import { DesktopShowContext } from '../useAgentDesktop'
import { ApprovalCard } from './ApprovalCard'
import { BotIcon } from './BotIcon'
import { PlanCard } from './PlanCard'
import { QuestionCard } from './QuestionCard'
import { ApprovalBox } from './VisitPanel'
import { CardQuestions } from './TodoCard'
import { unanswered } from '@zumibot/shared/todos'

type Point = { x: number; y: number }

interface Props {
  entry: WaitingEntry
  /** Answered here and its send not settled (or just done): hidden, never pressable, but kept with what was typed in it. */
  held: boolean
  chats: readonly ChatMeta[]
  agents: readonly AgentSummary[]
  now: number
  chatRunning: boolean
  /** Why the last answer from here failed, as the chat would say it; null: none. */
  error: string | null
  onAnswer: (answer: InboxAnswer) => void
  /** Open chat → or Open run →. */
  onOpen: () => void
  /** An approval card's Show on desktop / Open Desktop: the chat opens, then its desktop (no live view in the Inbox). */
  onShowDesktop: (agent: string, point: Point | null) => void
  /** A handoff's Open Desktop / Open Browser: the chat opens with the view on its card. */
  onOpenLive: () => void
}

/** One thing waiting on the user: who asks, where and how long, then today's card for it, answered in place. */
export function InboxCard({ entry, held, chats, agents, now, chatRunning, error, onAnswer, onOpen, onShowDesktop, onOpenLive }: Props) {
  const head = entryHeader(entry, chats, agents)
  const chat = entry.kind === 'workflow' || entry.kind === 'todo' ? undefined : chats.find((c) => c.id === entry.chatId)
  const agentName = head.who
  const agent = agentName === null ? null : (findAgent(agents, agentName) ?? missingAgent(agentName))
  const surface = entry.kind === 'handoff' ? (entry.item.surface === 'desktop' ? 'Desktop' : 'Browser') : null

  return (
    <article className="inbox-card" data-testid="inbox-card" data-kind={entry.kind} data-key={entry.key} hidden={held}>
      <header className="inbox-card-head">
        {agent ? (
          <BotIcon icon={agent.icon} color={agent.error === null ? agent.color : null} builtIn={agent.builtIn} working={false} size={18} />
        ) : (
          <span className="inbox-av" aria-hidden="true">
            ⇄
          </span>
        )}
        <span className="inbox-card-where">
          {entry.kind === 'workflow' ? (
            <b>{head.where}</b>
          ) : (
            <>
              {head.who !== null && <b>{mentionLabel(head.who)}</b>}
              {/* An A→B chat's line already says whom it is for: "@B, asked by @A in <title>"; a card's names it. */}
              {head.where !== '' && (head.who !== null ? (entry.kind === 'todo' ? ' asks about ' : chat?.asked ? ', ' : ' in ') : '')}
              {head.where}
            </>
          )}
          {surface && <> · {surface}</>}
          {' · '}
          <span className="inbox-card-age">{waitedText(entry.since, now)}</span>
        </span>
        <button type="button" className="inbox-link inbox-card-open" data-testid="inbox-open" onClick={onOpen}>
          {head.link === 'run' ? 'Open run →' : head.link === 'todo' ? 'Open to-do →' : 'Open chat →'}
        </button>
      </header>
      <CardBody
        entry={entry}
        chat={chat}
        chatRunning={chatRunning}
        onAnswer={onAnswer}
        onShowDesktop={onShowDesktop}
        onOpenLive={onOpenLive}
      />
      {error !== null && (
        <p className="inbox-error" data-testid="inbox-error" role="alert">
          {error}
        </p>
      )}
    </article>
  )
}

function CardBody({
  entry,
  chat,
  chatRunning,
  onAnswer,
  onShowDesktop,
  onOpenLive
}: Pick<Props, 'entry' | 'chatRunning' | 'onAnswer' | 'onShowDesktop' | 'onOpenLive'> & { chat: ChatMeta | undefined }) {
  if (entry.kind === 'workflow') {
    const { visit, step } = entry.approval
    // The Inbox holds the box under the answered line while the answer travels and shows it again, text and note kept,
    // if it fails (the reason goes under the card), so the box itself has nothing to wait on.
    return (
      <ApprovalBox
        visit={visit}
        step={step}
        onApprove={(_visitId, ok, text, note) => {
          onAnswer({ kind: 'workflow', ok, ...(text === undefined ? {} : { text }), ...(note === '' ? {} : { note }) })
          return Promise.resolve()
        }}
      />
    )
  }
  if (entry.kind === 'todo') {
    // Only what waits: answered questions are on the card. Drafts stay (false) while the Inbox holds the card for the send.
    return (
      <CardQuestions
        questions={unanswered(entry.item)}
        editable
        busy={false}
        onSend={(answers) => {
          onAnswer({ kind: 'todo', answers })
          return Promise.resolve(false)
        }}
      />
    )
  }
  if (entry.kind === 'handoff') {
    const name = entry.item.surface === 'desktop' ? 'Desktop' : 'Browser'
    return (
      <div className="inbox-handoff">
        <p className="inbox-handoff-reason">{entry.item.handoff.reason}</p>
        <div className="browser-action-buttons">
          <button type="button" className="btn small" data-testid="inbox-handoff-open" onClick={onOpenLive}>
            Open {name}
          </button>
          <button
            type="button"
            className="btn small primary"
            data-testid="inbox-handoff-done"
            onClick={() => onAnswer({ kind: 'handoff', decision: 'done' })}
          >
            I’m done
          </button>
          <button
            type="button"
            className="btn small ghost"
            data-testid="inbox-handoff-cancel"
            onClick={() => onAnswer({ kind: 'handoff', decision: 'cancel' })}
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }
  const item = entry.item
  const reply = (_id: string, r: ApprovalReply): void => onAnswer({ kind: 'card', reply: r })
  if (item.toolName === QUESTION_TOOL) return <QuestionCard item={item} chatRunning={chatRunning} onAnswer={reply} />
  if (item.toolName === PLAN_TOOL) return <PlanFold item={item} chatRunning={chatRunning} onAnswer={reply} />
  // A single chat's card has no agent of its own: it is the chat's.
  const show = (agent: string | undefined, point: Point | null): void => onShowDesktop(agent ?? chat?.agentName ?? '', point)
  return (
    <DesktopShowContext.Provider value={show}>
      <ApprovalCard item={item} chatRunning={chatRunning} stepChoice={stepChoiceFor(chat)} onAnswer={reply} />
    </DesktopShowContext.Provider>
  )
}

/** A plan folded to a few lines, with Show full plan when there is more of it. */
function PlanFold(p: Parameters<typeof PlanCard>[0]) {
  const [open, setOpen] = useState(false)
  const [long, setLong] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  // Measured after each draw: the fold is CSS, and only the browser knows whether the text overflows it.
  useLayoutEffect(() => {
    const body = box.current?.querySelector('.plan-body')
    if (!open && body instanceof HTMLElement) setLong(body.scrollHeight > body.clientHeight + 1)
  })
  const more =
    long || open ? (
      <button
        type="button"
        className="inbox-link inbox-plan-more"
        data-testid="inbox-plan-more"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? 'Show less' : 'Show full plan'}
      </button>
    ) : null
  return (
    <div ref={box} className={open ? 'inbox-plan' : 'inbox-plan folded'}>
      <PlanCard {...p} planMore={more} />
    </div>
  )
}
