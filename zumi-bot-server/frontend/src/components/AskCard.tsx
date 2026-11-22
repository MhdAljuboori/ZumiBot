import { createContext, useContext, useEffect, useState } from 'react'
import { displayName } from '@zumibot/shared/frontmatter'
import { PLAN_TOOL } from '@zumibot/shared/plans'
import { QUESTION_TOOL } from '@zumibot/shared/questions'
import type { AgentSummary, ChatItem, ChatMeta } from '@zumibot/shared/types'
import { mentionLabel } from '../state/agentNames'
import type { ApprovalReply } from '../state/approvals'
import { askCardState, askedChatOf, pendingAsked, type AskStatus } from '../state/agentAsk'
import { findAgent, missingAgent } from '../state/groupChat'
import { ApprovalCard } from './ApprovalCard'
import { BotIcon } from './BotIcon'
import { Markdown } from './Markdown'
import { PlanCard } from './PlanCard'
import { QuestionCard } from './QuestionCard'

/** What an ask card needs from the app: the asked chats, their live cards, and the ways to answer and open them. */
export interface AskEnv {
  chats: readonly ChatMeta[]
  pendingByChat: Record<string, number>
  /** The loaded items of a chat the card watches, if any. */
  itemsOf: (chatId: string) => ChatItem[] | undefined
  /** Loads (or reloads) a chat's items so its pending cards show here. */
  load: (chatId: string) => void
  /** The same answer path as the asked chat's own cards, with that chat's id. */
  answer: (chatId: string, requestId: string, reply: ApprovalReply, agent?: string) => void
  open: (chatId: string) => void
  /** Opens another chat on its Side questions view, scrolled to that entry (null: unfocused). */
  openSide: (chatId: string, entryId: string | null) => void
}

export interface AskScope {
  env: AskEnv
  agents: readonly AgentSummary[]
  /** The chat the card sits in, which is what its asked chat was started from. */
  sourceId: string
  /** Whether a result-less ask call is still going (see askLive); a stopped one stays stopped after the next send. */
  isLive: (toolId: string) => boolean
}

export const AskContext = createContext<AskScope | null>(null)

const STATUS_TEXT: Record<AskStatus, string> = {
  working: 'Working…',
  waiting: 'Waiting for you',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped'
}
// Past this a message might need more than its two clamped lines, so it gets a toggle.
const LONG = 140

type ToolItem = Extract<ChatItem, { type: 'tool' }>

/** An agent's `ask` call to another agent, in place of a tool row: who was asked, what, how it is going, and the way in. */
export function AskCard({ item }: { item: ToolItem }) {
  const scope = useContext(AskContext)
  const raw = (item.input as { agent?: unknown }).agent
  const asked = scope && typeof raw === 'string' ? askedChatOf(scope.env.chats, scope.sourceId, raw) : null
  const noResult = item.result === null || item.result === undefined
  // Only a call of the current turn shows or loads the asked chat's cards.
  const live = noResult && (scope?.isLive(item.id) ?? false)
  const state = askCardState(item, asked, scope?.env.pendingByChat ?? {}, live)
  const count = asked ? (scope?.env.pendingByChat[asked.id] ?? 0) : 0
  const [messageOpen, setMessageOpen] = useState(false)
  const [replyOpen, setReplyOpen] = useState(false)

  // The asked chat's own cards are its items, which nothing loads until someone opens that chat: load them while
  // they wait on the user, and again when their count moves.
  const watchId = live && count > 0 && asked ? asked.id : null
  const load = scope?.env.load
  useEffect(() => {
    if (watchId !== null) load?.(watchId)
  }, [watchId, count, load])

  const agent: AgentSummary = (scope && findAgent(scope.agents, state.target)) || missingAgent(state.target)
  const pending = live && asked && scope ? pendingAsked(scope.env.itemsOf(asked.id)) : []
  const further = Math.max(0, count - pending.length)
  const running = state.status === 'working' || state.status === 'waiting'
  const chatRunning = asked?.inFlight ?? false
  const answer = (id: string, reply: ApprovalReply, who?: string): void => {
    if (asked && scope) scope.env.answer(asked.id, id, reply, who)
  }

  return (
    <section className={`ask-card ${state.status}`} data-testid="ask-card" data-status={state.status}>
      <div className="ask-head">
        <BotIcon
          icon={agent.icon}
          color={agent.error === null ? agent.color : null}
          builtIn={agent.builtIn}
          working={state.status === 'working'}
          size={20}
        />
        <strong className="ask-name">{displayName(agent.name)}</strong>
        <span className="ask-verb">{running ? `Asking ${mentionLabel(state.target)}…` : `Asked ${mentionLabel(state.target)}`}</span>
      </div>
      {state.message !== '' && (
        <>
          <p className={messageOpen ? 'ask-message open' : 'ask-message'} dir="auto" data-testid="ask-message">
            {state.message}
          </p>
          {(state.message.length > LONG || state.message.includes('\n')) && (
            <button
              type="button"
              className="ask-toggle"
              data-testid="ask-message-toggle"
              aria-expanded={messageOpen}
              onClick={() => setMessageOpen((o) => !o)}
            >
              {messageOpen ? 'Less' : 'More'}
            </button>
          )}
        </>
      )}
      <div className="ask-status" data-testid="ask-status">
        {state.status === 'working' && <span className="spinner" role="status" aria-label="Asked agent working" />}
        <span>{STATUS_TEXT[state.status]}</span>
      </div>
      {pending.map((p) =>
        p.toolName === QUESTION_TOOL ? (
          <QuestionCard key={p.id} item={p} chatRunning={chatRunning} onAnswer={(id, reply) => answer(id, reply, p.agent)} />
        ) : p.toolName === PLAN_TOOL ? (
          <PlanCard key={p.id} item={p} chatRunning={chatRunning} onAnswer={(id, reply) => answer(id, reply, p.agent)} />
        ) : (
          <ApprovalCard
            key={p.id}
            item={p}
            chatRunning={chatRunning}
            stepChoice={false}
            onAnswer={(id, decision) => answer(id, decision, p.agent)}
          />
        )
      )}
      {further > 0 && (
        <p className="ask-further" data-testid="ask-further">
          More approvals wait further down the chain. Open the conversation to answer them.
        </p>
      )}
      {state.reply !== null && state.reply !== '' && (
        <div className="ask-reply">
          <button
            type="button"
            className="ask-toggle"
            data-testid="ask-reply-toggle"
            aria-expanded={replyOpen}
            onClick={() => setReplyOpen((o) => !o)}
          >
            {replyOpen ? 'Hide reply' : state.status === 'failed' ? 'Show details' : 'Show reply'}
          </button>
          {replyOpen && (
            <div className="ask-reply-body" dir="auto" data-testid="ask-reply">
              <Markdown text={state.reply} />
            </div>
          )}
        </div>
      )}
      <div className="ask-actions">
        <button
          type="button"
          className="btn small"
          data-testid="ask-open"
          disabled={state.chatId === null}
          onClick={() => state.chatId !== null && scope?.env.open(state.chatId)}
        >
          Open conversation
        </button>
      </div>
    </section>
  )
}
