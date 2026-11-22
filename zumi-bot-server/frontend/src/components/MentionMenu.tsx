import { useEffect, useRef } from 'react'
import { displayName } from '@zumibot/shared/frontmatter'
import { EVERYONE } from '@zumibot/shared/mentions'
import type { AgentSummary } from '@zumibot/shared/types'
import { mentionOptionName, type MentionOption } from '../state/mentionInput'
import { BotIcon } from './BotIcon'
import { MemberStack } from './MemberStack'

interface Props {
  options: readonly MentionOption[]
  /** Everyone the `@everyone` row stands for, drawn as its icon. */
  members: AgentSummary[]
  active: number
  onActive: (index: number) => void
  /** The handle to insert, without its `@`. */
  onPick: (name: string) => void
}

/** The `@` list of the composer and the message editor. */
export function MentionMenu({ options, members, active, onActive, onPick }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  // Arrow keys can move past the menu's max height; keep the row they reach in view.
  useEffect(() => {
    ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  // mousedown is held back so the text box keeps its focus (and caret) while a row is clicked.
  return (
    <div
      className="menu mention-menu"
      role="listbox"
      aria-label="Mention a member"
      data-testid="mention-menu"
      ref={ref}
      onMouseDown={(e) => e.preventDefault()}
    >
      {options.map((o, i) => {
        const name = mentionOptionName(o)
        return (
          <button
            key={o === 'everyone' ? EVERYONE : o.filePath}
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={i === active}
            className={i === active ? 'on' : undefined}
            data-testid="mention-option"
            data-agent-name={name}
            onMouseEnter={() => onActive(i)}
            onClick={() => onPick(name)}
          >
            {o === 'everyone' ? (
              <MemberStack agents={members} size={18} max={3} working={[]} />
            ) : (
              <BotIcon icon={o.icon} color={o.error === null ? o.color : null} builtIn={o.builtIn} working={false} size={18} />
            )}
            <span className="picker-text">{o === 'everyone' ? 'Everyone' : displayName(o.name)}</span>
            <span className="mention-handle">@{name}</span>
          </button>
        )
      })}
    </div>
  )
}
