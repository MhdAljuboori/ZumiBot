import type { CSSProperties } from 'react'
import type { SentCommand } from '@zumibot/shared/commands'
import type { AgentSummary } from '@zumibot/shared/types'
import { TODO_NAME } from '@zumibot/shared/todos'
import { agentInk } from '../state/bot'
import { chipBroken, leadChips } from '../state/commandBubble'
import { BotIcon } from './BotIcon'
import { UserText, type UserLead, type UserMentions } from './UserText'

/**
 * A sent command: the bubble with `/name` as a chip in the agent's color. The "Full prompt" toggle is `FullPrompt`, drawn
 * under the whole message row so the hover buttons sit beside the bubble; the chip and the toggle flip the same box, so
 * the open state is kept by the list (by message id), collapsed until clicked. An engine command's chip carries the engine's label and opens nothing. A message that began with `/todo` shows
 * it as a chip too, in front of the command's; `/todo` alone has no prompt to open, so its chip is not a button.
 */
export function CommandBubble({
  text,
  command,
  todo,
  agent,
  inRoom,
  mentions,
  open,
  onToggle
}: {
  text: string
  command: SentCommand | null
  todo: boolean
  agent: AgentSummary | undefined
  inRoom: boolean
  mentions: UserMentions | null
  open: boolean
  onToggle: () => void
}) {
  const leads: UserLead[] = leadChips(text, command?.name ?? null, todo).map((name) => ({
    name,
    node:
      command && name === command.name ? (
        commandChip(command)
      ) : (
        <span className="mention command-chip todo" data-testid="todo-chip">
          /{TODO_NAME}
        </span>
      )
  }))
  return (
    <div className="bubble user">
      <UserText text={text} mentions={mentions} leads={leads} />
    </div>
  )

  // The text should always start with the command; if not, leadChips leaves it out and only the toggle is left.
  function commandChip(c: SentCommand) {
    const broken = chipBroken(agent, c.name, c.engine !== undefined)
    const tint = !broken && agent ? agentInk(agent.color) : null
    const style = tint ? ({ '--mention': tint } as CSSProperties) : undefined
    // An engine command sends its own text (no filled prompt to open), so its chip is a label, not the toggle.
    if (c.engine) {
      return (
        <span className={broken ? 'mention command-chip broken' : 'mention command-chip'} data-testid="command-chip" style={style}>
          /{c.name}
          <span className="command-chip-engine" data-testid="command-chip-engine">
            {c.engine}
          </span>
        </span>
      )
    }
    return (
      <button
        type="button"
        className={broken ? 'mention command-chip broken' : 'mention command-chip'}
        data-testid="command-chip"
        aria-expanded={open}
        style={style}
        onClick={onToggle}
      >
        {inRoom && agent && (
          <BotIcon icon={agent.icon} color={broken ? null : agent.color} builtIn={agent.builtIn} working={false} size={14} />
        )}
        /{c.name}
      </button>
    )
  }
}

/** The "Full prompt" toggle under a sent command or a card comment, and the exact text the agent read when it is open. */
export function FullPrompt({ prompt, open, onToggle }: { prompt: string; open: boolean; onToggle: () => void }) {
  return (
    <>
      <button
        type="button"
        className={open ? 'full-prompt-toggle open' : 'full-prompt-toggle'}
        data-testid="full-prompt-toggle"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="caret" aria-hidden="true" />
        Full prompt
      </button>
      {open && (
        <div className="full-prompt" data-testid="full-prompt">
          {prompt}
        </div>
      )}
    </>
  )
}
