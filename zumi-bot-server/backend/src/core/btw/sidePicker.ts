import { displayName } from '@zumibot/shared/frontmatter'
import type { MemberInfo, ThreadEntry } from '../chat/groupPrompts'
import { MODERATOR_MESSAGES, MODERATOR_MESSAGE_CHARS } from '../chat/moderator'

export interface PickInput {
  members: MemberInfo[]
  messages: ThreadEntry[]
  working: string[]
  question: string
}

const SCHEMA = '{"type":"object","properties":{"member":{"type":"string"}},"required":["member"],"additionalProperties":false}'
const SYSTEM_PROMPT =
  "Pick the single member best placed to answer this side question about the group's work, preferring the member doing the work it asks about. Use the member's handle only, without @ or a display name."

export function pickArgs(): string[] {
  return [
    '-p',
    '--model',
    'haiku',
    '--tools',
    '',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--output-format',
    'json',
    '--json-schema',
    SCHEMA,
    '--system-prompt',
    SYSTEM_PROMPT
  ]
}

export function pickPrompt(i: PickInput): string {
  const roster = i.members.map((m) => `- @${m.name} (${displayName(m.name)}): ${m.description}`).join('\n')
  const thread = i.messages.slice(-MODERATOR_MESSAGES).map((e) => {
    const files = e.attachments?.length ? ` [attached: ${e.attachments.map((a) => a.name).join(', ')}]` : ''
    return `<message from="${e.from ?? 'user'}">${e.text.slice(0, MODERATOR_MESSAGE_CHARS)}${files}</message>`
  })
  return [
    'Members:',
    roster,
    '',
    'Thread (latest last):',
    ...thread,
    '',
    `Working now: ${i.working.length ? i.working.map((m) => `@${m}`).join(', ') : 'nobody'}`,
    '',
    'Side question:',
    i.question
  ].join('\n')
}

export function parsePick(stdout: string, members: readonly string[]): string | null {
  try {
    const root = JSON.parse(stdout)
    if (!root || typeof root !== 'object' || root.is_error) return null
    const raw = root.structured_output ?? (typeof root.result === 'string' ? JSON.parse(root.result) : root)
    if (typeof raw?.member !== 'string') return null
    const key = raw.member.trim().replace(/^@/, '').toLowerCase()
    return members.find((m) => m.toLowerCase() === key || displayName(m).toLowerCase() === key) ?? null
  } catch {
    return null
  }
}

export function fallbackPick(i: PickInput): string {
  if (i.working.length === 1) return i.working[0]
  for (let n = i.messages.length - 1; n >= 0; n--) {
    const from = i.messages[n].from
    if (from !== null && i.members.some((m) => m.name === from)) return from
  }
  return i.members[0].name
}
