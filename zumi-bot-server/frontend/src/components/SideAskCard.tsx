import { useContext, useState } from 'react'
import { displayName } from '@zumibot/shared/frontmatter'
import type { AgentSummary, ChatItem } from '@zumibot/shared/types'
import { api } from '../api'
import { askedChatOf, findSideEntry, sideAskCardState } from '../state/agentAsk'
import { mentionLabel } from '../state/agentNames'
import { findAgent, missingAgent } from '../state/groupChat'
import { AskContext } from './AskCard'
import { BotIcon } from './BotIcon'
import { Markdown } from './Markdown'

const STATUS_TEXT = { working: 'Working…', done: 'Done', failed: 'Failed', stopped: 'Stopped' } as const
// Past this a question might need more than its two clamped lines, so it gets a toggle.
const LONG = 140

type ToolItem = Extract<ChatItem, { type: 'tool' }>

/** An agent's `side_question` call to an agent it already asked, in place of a tool row: who, what, the answer, and the way in. */
export function SideAskCard({ item }: { item: ToolItem }) {
  const scope = useContext(AskContext)
  const raw = (item.input as { agent?: unknown }).agent
  const asked = scope && typeof raw === 'string' ? askedChatOf(scope.env.chats, scope.sourceId, raw) : null
  const noResult = item.result === null || item.result === undefined
  const live = noResult && (scope?.isLive(item.id) ?? false)
  const state = sideAskCardState(item, live)
  const [questionOpen, setQuestionOpen] = useState(false)
  const [answerOpen, setAnswerOpen] = useState(false)
  const [opening, setOpening] = useState(false)

  const agent: AgentSummary = (scope && findAgent(scope.agents, state.target)) || missingAgent(state.target)
  const running = state.status === 'working'
  // B's entry is found by who asked and what, since the call carries no entry id.
  const open = async (): Promise<void> => {
    if (!asked || !scope || opening) return
    setOpening(true)
    try {
      const from = scope.env.chats.find((c) => c.id === scope.sourceId)?.agentName ?? ''
      const list = await api.btw.list(asked.id).catch(() => [])
      scope.env.openSide(asked.id, findSideEntry(list, from, state.question, item.ts)?.id ?? null)
    } finally {
      setOpening(false)
    }
  }

  return (
    <section className={`ask-card side-ask-card ${state.status}`} data-testid="side-ask-card" data-status={state.status}>
      <div className="ask-head">
        <BotIcon icon={agent.icon} color={agent.error === null ? agent.color : null} builtIn={agent.builtIn} working={running} size={20} />
        <strong className="ask-name">{displayName(agent.name)}</strong>
        <span className="ask-verb">
          {running ? `Asking ${mentionLabel(state.target)} on the side…` : `Asked ${mentionLabel(state.target)} on the side`}
        </span>
      </div>
      {state.question !== '' && (
        <>
          <p className={questionOpen ? 'ask-message open' : 'ask-message'} dir="auto" data-testid="side-ask-question">
            {state.question}
          </p>
          {(state.question.length > LONG || state.question.includes('\n')) && (
            <button type="button" className="ask-toggle" aria-expanded={questionOpen} onClick={() => setQuestionOpen((o) => !o)}>
              {questionOpen ? 'Less' : 'More'}
            </button>
          )}
        </>
      )}
      <div className="ask-status" data-testid="side-ask-status">
        {running && <span className="spinner" role="status" aria-label="Asked agent working" />}
        <span>{STATUS_TEXT[state.status]}</span>
      </div>
      {state.answer !== null && state.answer !== '' && (
        <div className="ask-reply">
          <button
            type="button"
            className="ask-toggle"
            data-testid="side-ask-answer-toggle"
            aria-expanded={answerOpen}
            onClick={() => setAnswerOpen((o) => !o)}
          >
            {answerOpen ? 'Hide answer' : state.status === 'failed' ? 'Show details' : 'Show answer'}
          </button>
          {answerOpen && (
            <div className="ask-reply-body" dir="auto" data-testid="side-ask-answer">
              <Markdown text={state.answer} />
            </div>
          )}
        </div>
      )}
      <div className="ask-actions">
        <button
          type="button"
          className="btn small"
          data-testid="side-ask-open"
          disabled={asked === null || opening}
          onClick={() => void open()}
        >
          Open in conversation
        </button>
      </div>
    </section>
  )
}
