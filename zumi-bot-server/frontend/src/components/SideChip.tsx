import { displayName } from '@zumibot/shared/frontmatter'
import type { AgentSummary } from '@zumibot/shared/types'
import { agentColor } from '../state/bot'
import { findAgent } from '../state/groupChat'
import { chipText, type SideThread } from '../state/sideQuestions'

export function SideChip({
  thread,
  agents,
  room,
  onOpen
}: {
  thread: SideThread
  agents: AgentSummary[]
  room: boolean
  onOpen: (id: string) => void
}) {
  const entry = thread.root
  const agent = room && entry.agent ? findAgent(agents, entry.agent) : undefined
  const color = agent && agent.error === null ? agentColor(agent.color) : null
  return (
    <div className="side-chip-row" data-side-id={thread.id}>
      <button
        type="button"
        className="side-chip"
        data-testid="side-chip"
        data-state={thread.status}
        data-tip={entry.question}
        onClick={() => onOpen(thread.id)}
      >
        {thread.open && <span className="spinner" aria-label="Answering" />}
        {thread.status === 'error' && (
          <span className="side-warning" aria-label="Error">
            ⚠
          </span>
        )}
        <span className="side-chip-text">{chipText(entry)}</span>
        {room && entry.agent && (
          <span className="side-chip-who" data-agent-name={entry.agent}>
            <span className="file-dot" aria-hidden="true" style={color ? { background: color } : undefined} />
            {displayName(entry.agent)}
          </span>
        )}
      </button>
    </div>
  )
}
