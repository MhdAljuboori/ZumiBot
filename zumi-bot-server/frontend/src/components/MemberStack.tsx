import type { CSSProperties } from 'react'
import type { AgentSummary } from '@zumibot/shared/types'
import { BotIcon } from './BotIcon'

interface Props {
  agents: AgentSummary[]
  /** Each icon's round tile, in px. */
  size: number
  /** The members taking a turn: their icons bob. */
  working: readonly string[]
  /** Icons shown before the rest collapse into "+N". A lone extra member shows as its icon: "+1" would take the same room. */
  max?: number
}

/** A group's members as overlapping bot icons. */
export function MemberStack({ agents, size, working, max = agents.length }: Props) {
  const shown = agents.length <= max + 1 ? agents : agents.slice(0, max)
  const extra = agents.length - shown.length
  return (
    <span className="member-stack" style={{ '--stack-size': `${size}px` } as CSSProperties} aria-hidden="true">
      {shown.map((a) => (
        <span key={a.filePath || a.name} className="member-stack-item">
          <BotIcon
            icon={a.icon}
            color={a.error === null ? a.color : null}
            builtIn={a.builtIn}
            working={working.includes(a.name)}
            size={Math.round(size * 0.8)}
          />
        </span>
      ))}
      {extra > 0 && <span className="member-stack-item more">+{extra}</span>}
    </span>
  )
}
