import { displayName } from '@zumibot/shared/frontmatter'
import type { AgentSummary } from '@zumibot/shared/types'
import { findAgent, memberOptions, toggleMember } from '../state/groupChat'
import { BotIcon } from './BotIcon'

interface Props {
  agents: AgentSummary[]
  selected: string[]
  /** Nothing can change (the group is working). */
  disabled: boolean
  /** An existing group: unchecking may not leave fewer than the minimum. The new-chat screen never locks. */
  keepMinimum: boolean
  onChange: (members: string[]) => void
  /** The options' data-testid: the new-chat screen and an open group name theirs apart. */
  optionTestId?: string
}

/** The Members checklist, placed inside a picker menu; it stays open while members are ticked. */
export function MembersMenu({ agents, selected, disabled, keepMinimum, onChange, optionTestId = 'members-option' }: Props) {
  const options = memberOptions(agents, selected, keepMinimum)
  return (
    <>
      <div className="menu-label">Members</div>
      {options.map((o) => {
        const off = disabled || o.disabled
        const gone = o.agent === undefined || o.agent.error !== null
        return (
          <button
            key={o.agent?.filePath || o.name}
            type="button"
            role="menuitemcheckbox"
            className={gone ? 'member-option gone' : 'member-option'}
            aria-checked={o.checked}
            aria-disabled={off}
            data-testid={optionTestId}
            data-agent-name={o.name}
            data-tip={o.note === 'missing' ? `${o.name}: the agent file is gone` : (o.agent?.error ?? undefined)}
            onClick={() => {
              if (!off) onChange(toggleMember(selected, o.name))
            }}
          >
            <span className="check" aria-hidden="true">
              {o.checked && (
                <svg viewBox="0 0 16 16">
                  <path
                    d="M3.5 8.5l3 3 6-7"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </span>
            <BotIcon
              icon={o.agent?.icon ?? null}
              color={gone ? null : (o.agent?.color ?? null)}
              builtIn={o.agent?.builtIn}
              working={false}
              size={18}
            />
            <span className="picker-text">{o.note === 'missing' ? `@${o.name}` : displayName(o.name)}</span>
            {o.note && <span className="member-note">{o.note}</span>}
          </button>
        )
      })}
    </>
  )
}

/** An open group's members, read-only, placed inside a picker menu: who is in the group, in member order. */
export function MemberList({
  agents,
  members,
  working
}: {
  agents: AgentSummary[]
  members: readonly string[]
  working: readonly string[]
}) {
  return (
    <>
      <div className="menu-label" id="member-list-label">
        Members
      </div>
      <ul className="member-list" aria-labelledby="member-list-label">
        {members.map((name) => {
          const agent = findAgent(agents, name)
          const gone = agent === undefined || agent.error !== null
          return (
            <li
              key={name}
              className={gone ? 'member-row gone' : 'member-row'}
              data-testid="members-row"
              data-agent-name={name}
              data-tip={agent === undefined ? `${name}: the agent file is gone` : (agent.error ?? undefined)}
            >
              <BotIcon
                icon={agent?.icon ?? null}
                color={gone ? null : (agent?.color ?? null)}
                builtIn={agent?.builtIn}
                working={working.includes(name)}
                size={18}
              />
              <span className="picker-text">{agent === undefined ? `@${name}` : displayName(name)}</span>
              {agent === undefined ? <span className="member-note">missing</span> : <span className="mention-handle">@{name}</span>}
            </li>
          )
        })}
      </ul>
    </>
  )
}
