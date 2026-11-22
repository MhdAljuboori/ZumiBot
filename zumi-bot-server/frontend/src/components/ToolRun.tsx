import type { AgentBlock } from '../state/messageGroups'
import { thoughtLabel, thoughtPreview } from '../state/messageGroups'
import { sandboxRunLine } from '../state/sandboxLine'
import { ThoughtRow } from './ThoughtRow'
import { ToolCallRow } from './ToolCallRow'

interface Props {
  block: Extract<AgentBlock, { kind: 'tools' }>
  /** The chat is running and this run is its latest output. */
  thinking: boolean
  /** The agent's thinking as it streams, while `thinking`; '' when none comes. */
  liveThought?: string
  open: boolean
  onToggle: () => void
}

/**
 * A run of back-to-back tool calls and thinking as one row: "Thinking…" while it runs (with the line the agent is thinking
 * now, when its thinking streams), "Thought for Xs" after; opens to the calls and thoughts.
 */
export function ToolRun({ block, thinking, liveThought = '', open, onToggle }: Props) {
  const now = thinking ? thoughtPreview(liveThought) : ''
  // Folded, the run still says what the sandbox refused; open, each row says it under itself.
  const blocked = open ? null : sandboxRunLine(block.tools)
  return (
    <div className="tool-run" data-testid="tool-run">
      <button type="button" className="tool-run-head" aria-expanded={open} onClick={onToggle}>
        <span className="tool-run-caret" aria-hidden="true">
          ▸
        </span>
        {thinking ? (
          <>
            <span className="spinner" role="status" aria-label="Reply running" /> Thinking…
            {now !== '' && (
              <span className="live-thought" data-testid="live-thought" data-tip={now}>
                {now}
              </span>
            )}
          </>
        ) : (
          thoughtLabel(block.ms)
        )}
      </button>
      {blocked && (
        <div className="tool-sandbox-line" data-testid="tool-run-sandbox-line">
          {blocked}
        </div>
      )}
      {open && (
        <div className="tool-run-body">
          {block.tools.map((t) => (t.type === 'thinking' ? <ThoughtRow key={t.id} item={t} /> : <ToolCallRow key={t.id} item={t} />))}
        </div>
      )}
    </div>
  )
}
