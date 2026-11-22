import { Fragment, useMemo, type ReactNode } from 'react'
import type { JSONContent } from '@tiptap/core'
import type { AgentSummary } from '@zumibot/shared/types'
import { fromMarkdown } from '../state/composerMarkdown'
import { mentionSegments } from '../state/groupChat'
import { MentionText } from './Mention'

/** A chat's handles and agents, for mention chips. */
export interface UserMentions {
  members: string[]
  agents: AgentSummary[]
  memberAgents: AgentSummary[]
  /** `@everyone` is a chip only in a room: a single chat has no group to address. */
  everyone: boolean
}

/** A chip standing in for the message's leading `/name`. */
export interface UserLead {
  name: string
  node: ReactNode
}

function inline(nodes: JSONContent[], mentions: UserMentions | null, leads: readonly UserLead[] = []): ReactNode[] {
  return nodes.map((n, i) => {
    let text = n.text ?? ''
    const chips: ReactNode[] = []
    if (i === 0 && !n.marks?.some((m) => m.type === 'code')) {
      // In order (`/todo` then `/command`): each one stands in only while the text still starts with its name.
      for (const lead of leads) {
        const probe = chips.length > 0 ? text.trimStart() : text
        if (!probe.startsWith(`/${lead.name}`)) break
        chips.push(<Fragment key={lead.name}>{lead.node}</Fragment>)
        text = probe.slice(lead.name.length + 1)
      }
    }
    if (n.marks?.some((m) => m.type === 'code')) return <code key={i}>{text}</code>
    const rest = mentions ? (
      <MentionText
        key={i}
        segments={mentionSegments(text, mentions.members, mentions.everyone)}
        agents={mentions.agents}
        members={mentions.memberAgents}
      />
    ) : (
      text
    )
    return chips.length > 0 ? (
      <Fragment key={i}>
        {chips.map((c, k) => (
          <Fragment key={k}>
            {k > 0 && ' '}
            {c}
          </Fragment>
        ))}
        {rest}
      </Fragment>
    ) : (
      rest
    )
  })
}

function blocks(nodes: JSONContent[] = [], mentions: UserMentions | null, leads?: readonly UserLead[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.type) {
      case 'paragraph':
        return <p key={i}>{n.content ? inline(n.content, mentions, i === 0 ? leads : undefined) : <br />}</p>
      case 'codeBlock':
        return (
          <pre key={i}>
            <code>{(n.content ?? []).map((t) => t.text ?? '').join('')}</code>
          </pre>
        )
      case 'blockquote':
        return <blockquote key={i}>{blocks(n.content, mentions)}</blockquote>
      case 'bulletList':
        return <ul key={i}>{blocks(n.content, mentions)}</ul>
      case 'orderedList':
        return (
          <ol key={i} start={Number(n.attrs?.start ?? 1)}>
            {blocks(n.content, mentions)}
          </ol>
        )
      case 'listItem':
        return <li key={i}>{blocks(n.content, mentions)}</li>
      default:
        return null
    }
  })
}

/**
 * A sent message drawn the way the composer showed it, read with the composer's own markdown: lines, `-` and `1.`
 * lists, `code` and code blocks. Other markdown stays as typed. @mentions outside code are chips.
 */
export function UserText({ text, mentions, leads }: { text: string; mentions: UserMentions | null; leads?: readonly UserLead[] }) {
  const doc = useMemo(() => fromMarkdown(text.replace(/^\n+|\n+$/g, '')), [text])
  return <div className="sent-text">{blocks(doc.content, mentions, leads)}</div>
}
