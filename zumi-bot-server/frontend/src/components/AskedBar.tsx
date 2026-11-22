import type { AgentSummary, AskedFrom } from '@zumibot/shared/types'
import { askedBarText } from '../state/agentAsk'

interface Props {
  asked: AskedFrom
  /** The agent that was asked: the chat's own. */
  agentName: string
  /** Every agent, so names and the source title read as display names. */
  agents: readonly AgentSummary[]
  /** The chat it was asked from is still listed: its title opens it. */
  sourceExists: boolean
  onOpenSource: () => void
}

/** Takes the composer's place in a chat another agent started: the user can read it but not write in it. */
export function AskedBar({ asked, agentName, agents, sourceExists, onOpenSource }: Props) {
  const { lead, source } = askedBarText(asked, agentName, sourceExists, agents)
  return (
    <div className="asked-bar" role="status" data-testid="asked-bar">
      <span className="asked-bar-text">
        {lead}{' '}
        {source !== null ? (
          <button type="button" className="asked-source" data-testid="asked-source" data-tip="Open that chat" onClick={onOpenSource}>
            {source}
          </button>
        ) : (
          <span className="asked-source-gone">(deleted chat)</span>
        )}
      </span>
    </div>
  )
}
