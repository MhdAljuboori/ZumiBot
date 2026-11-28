import { CHAT_READ_MAX } from '@zumibot/shared/automations'
import { archivedFromPath, chatIdFromPath } from '@zumibot/shared/appPaths'
import { PLAN_TOOL } from '@zumibot/shared/plans'
import { parseQuestions, QUESTION_TOOL } from '@zumibot/shared/questions'
import { toolSummary } from '@zumibot/shared/toolSummary'
import { isGroup, type ChatItem, type ChatMeta } from '@zumibot/shared/types'
import { cutLines } from '../chat/roomSummary'

// The same charset ChatStore accepts for an id.
const ID_RE = /^[A-Za-z0-9-]{1,100}$/
const INPUT_MAX = 2048
const LINE_MAX = 20_000

/** The chat id in a bare id, an app path (`/chat/<id>`, `/archived/<id>`) or a full URL of one; null otherwise. */
export function chatIdFrom(text: string): string | null {
  const s = text.trim()
  if (s === '' || s.length > INPUT_MAX) return null
  if (ID_RE.test(s)) return s
  let pathname: string
  if (/^https?:\/\//i.test(s)) {
    try {
      pathname = new URL(s).pathname
    } catch {
      return null
    }
  } else if (s.startsWith('/')) {
    pathname = s.split(/[?#]/)[0]
  } else return null
  // A /todos/<id> link names a board card, not a chat.
  const id = chatIdFromPath(pathname) ?? archivedFromPath(pathname)?.chatId ?? null
  return id !== null && ID_RE.test(id) ? id : null
}

// A closing tag inside a message could end the block early and pass the rest off as the caller's own words.
const defang = (s: string): string => s.replace(/<\/(chat)(\s*)>/gi, '<\\/$1$2>')

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)

const oneLine = (s: string): string => defang(s.replace(/\s+/g, ' ').trim())

function lineOf(item: ChatItem, fallbackAgent: string): string | null {
  switch (item.type) {
    case 'user': {
      // `text` is the short form of a command; the filled prompt stays out.
      const files = item.attachments?.length ? ` [attached: ${item.attachments.map((a) => oneLine(a.name)).join(', ')}]` : ''
      return `[${item.from ? `@${item.from} asking` : 'user'}] ${defang(item.text)}${files}`
    }
    case 'assistant':
      return `[@${item.agent || fallbackAgent}] ${defang(item.text)}`
    case 'tool': {
      const tag = item.isError ? ' (error)' : item.blocked ? ' (blocked)' : ''
      return `tool: ${oneLine(toolSummary(item.name, item.input))}${tag}${item.agent ? ` [@${item.agent}]` : ''}`
    }
    case 'approval': {
      const who = item.agent ? ` [@${item.agent}]` : ''
      if (item.toolName === PLAN_TOOL) return `plan: ${item.status}${who}`
      if (item.toolName === QUESTION_TOOL) {
        const asked = parseQuestions(item.input)
          ?.questions.map((q) => oneLine(q.text))
          .join(' | ')
        return `question: ${item.status}${asked ? ` · ${asked}` : ''}${who}`
      }
      return `approval: ${oneLine(item.toolName)} ${item.status}${who}`
    }
    case 'error':
      return `error: ${defang(item.text)}`
    case 'notice':
      return `notice: ${defang(item.text)}`
    default:
      return null
  }
}

/** A read-only text of a chat's visible items for an agent: one `<chat id>` block that no message text can close, cut to `max`. */
export function chatTranscript(meta: ChatMeta, items: readonly ChatItem[], max = CHAT_READ_MAX): string {
  const id = meta.id.replace(/[^A-Za-z0-9-]/g, '')
  const who = isGroup(meta)
    ? [
        `Room members: ${meta.group.members.map((m) => `@${m}`).join(', ')}`,
        ...(meta.group.role.trim() ? [`Role: ${clip(oneLine(meta.group.role), 2000)}`] : [])
      ]
    : [`Agent: @${meta.agentName}`]
  const head = [
    `<chat id="${id}">`,
    `Title: ${clip(oneLine(meta.title), 200)}`,
    ...who,
    `Folder: ${clip(oneLine(meta.cwd), 500)}`,
    // A worktree chat's folder may be removed later: what is made from it runs in the folder the user picked.
    ...(meta.worktree ? [`Worktree of: ${clip(oneLine(meta.worktree.folder), 500)}`] : []),
    `Items: ${items.length}`
  ].join('\n')
  const close = '</chat>'
  const lines: string[] = []
  let first = -1
  for (const item of items) {
    const l = lineOf(item, meta.agentName)
    if (l === null) continue
    if (item.type === 'user' && first < 0) first = lines.length
    lines.push(l.length > LINE_MAX ? l.slice(0, LINE_MAX - 1) + '…' : l)
  }
  if (lines.length === 0) return `${head}\n${close}`
  const body = cutLines(lines, Math.max(first, 0), Math.max(max - head.length - close.length - 2, 0), '…')
  return `${head}\n${body}\n${close}`
}
