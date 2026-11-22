import type { CSSProperties } from 'react'
import { displayName } from '@zumibot/shared/frontmatter'
import { EVERYONE, type MentionSegment } from '@zumibot/shared/mentions'
import type { AgentSummary } from '@zumibot/shared/types'
import { agentInk } from '../state/bot'
import { findAgent } from '../state/groupChat'
import { BotIcon } from './BotIcon'
import { MemberStack } from './MemberStack'

/** A member mention in a sent message: the bot icon and display name in the agent's color; greyed `@name` once it is gone. */
export function Mention({ agent, name }: { agent: AgentSummary | undefined; name: string }) {
  if (!agent) {
    return (
      <span className="mention missing" data-testid="mention" data-agent-name={name}>
        @{name}
      </span>
    )
  }
  const ok = agent.error === null
  const tint = ok ? agentInk(agent.color) : null
  return (
    <span
      className={ok ? 'mention' : 'mention broken'}
      data-testid="mention"
      data-agent-name={agent.name}
      style={tint ? ({ '--mention': tint } as CSSProperties) : undefined}
    >
      <BotIcon icon={agent.icon} color={ok ? agent.color : null} builtIn={agent.builtIn} working={false} size={14} />
      {displayName(agent.name)}
    </span>
  )
}

/** `@everyone` in the user's message: the members' stacked icons and the word, in the neutral color. */
export function EveryoneMention({ members }: { members: AgentSummary[] }) {
  return (
    <span className="mention everyone" data-testid="mention" data-agent-name={EVERYONE}>
      <MemberStack agents={members} size={14} max={3} working={[]} />
      {EVERYONE}
    </span>
  )
}

/** Text with its mention segments drawn as chips; `members` are the group's agents, for an @everyone chip. */
export function MentionText({
  segments,
  agents,
  members
}: {
  segments: MentionSegment[]
  agents: AgentSummary[]
  members: AgentSummary[]
}) {
  return segments.map((s, i) =>
    s.kind === 'text' ? (
      s.text
    ) : s.name === EVERYONE ? (
      <EveryoneMention key={i} members={members} />
    ) : (
      <Mention key={i} agent={findAgent(agents, s.name)} name={s.name} />
    )
  )
}

/** A `/name` a comment runs: the chat's command chip, in its agent's color (neutral when several agents run it). */
export function CommandMark({ name, agent }: { name: string; agent: AgentSummary | undefined }) {
  const tint = agent && agent.error === null ? agentInk(agent.color) : null
  return (
    <span
      className="mention command-chip"
      data-testid="comment-command"
      data-command={name}
      style={tint ? ({ '--mention': tint } as CSSProperties) : undefined}
    >
      /{name}
    </span>
  )
}
