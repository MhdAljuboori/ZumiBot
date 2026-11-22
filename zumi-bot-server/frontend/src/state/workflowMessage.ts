import type { ChatItem, ChatMeta, WorkflowLink } from '@zumibot/shared/types'
import { workflowsPath } from './route'

// A workflow step's message, drawn for the reader. The agent reads the exact text, with each untrusted value wrapped as
// `<input from="…">` (inputBlock in shared/workflowTemplate.ts); the chat shows those blocks as labelled boxes instead.
// Display only: the stored item, Copy, Edit and what the agent reads never change.

export type PromptPart = { kind: 'text'; text: string } | { kind: 'input'; from: string; text: string }

// Exactly the shape inputBlock writes. Material has every `</input` escaped, so the first `\n</input>` ends the block,
// and an opening tag inside material stays material.
const BLOCK_RE = /<input from="([^"\r\n]*)">\n([\s\S]*?)\n<\/input>/g

// Undoes escapeMaterial for the reader. Material that held a literal `<\/input` shows it as `</input`, a harmless slip.
const unescape = (s: string): string => s.replace(/<\\\/(input)/gi, '</$1')

export function promptParts(text: string): PromptPart[] {
  const parts: PromptPart[] = []
  const pushText = (s: string): void => {
    const t = s.trim()
    if (t !== '') parts.push({ kind: 'text', text: t })
  }
  let at = 0
  for (const m of text.matchAll(BLOCK_RE)) {
    pushText(text.slice(at, m.index))
    parts.push({ kind: 'input', from: m[1], text: unescape(m[2]) })
    at = m.index + m[0].length
  }
  if (at === 0) return [{ kind: 'text', text }]
  pushText(text.slice(at))
  return parts
}

/** A block's source: a step's name as it was, or the template's fixed `item` and `trigger` sources in words. */
export function inputLabel(from: string, link: WorkflowLink | undefined): string {
  if (from === 'item') return link?.item ? `Item ${link.item.n} of ${link.item.total}` : 'Item'
  if (from === 'trigger') return 'Trigger'
  return from
}

/** Who sent a workflow chat's step messages: the workflow and the step (its name now), or a Run step test. */
export function workflowSender(chat: Pick<ChatMeta, 'workflow' | 'workflowTest'>, stepName: string | undefined): string | null {
  if (chat.workflow) {
    const step = stepName?.trim()
    return step ? `${chat.workflow.name} › ${step}` : chat.workflow.name
  }
  if (chat.workflowTest !== undefined) return `${chat.workflowTest} · step test`
  return null
}

/** Who sent a message: the workflow, its step, and the run's address while it is a workflowSent item (which has one). */
export interface Sender {
  name: string
  step?: string
  path?: string
}

export const senderText = (s: Sender): string => (s.step ? `${s.name} › ${s.step}` : s.name)

/**
 * The workflow that sent a user message, or null. A `workflowSent` item says so itself, in any chat (a Chat step posts
 * into the user's own chat), and wins. In a workflow's own chat items carry no sender, so the chat is read: the workflow
 * made it and sent its first message (`first`: this is the chat's first user message and the whole history is loaded),
 * and every later step message (a loop's revisit) holds an input block. A usage limit's `continue` reads as the user's.
 */
export function senderOf(
  item: ChatItem,
  chat: Pick<ChatMeta, 'workflow' | 'workflowTest'>,
  first: boolean,
  stepName?: string
): Sender | null {
  if (item.type !== 'user') return null
  const sent = item.workflowSent
  if (sent) return { name: sent.name, step: sent.step, path: workflowsPath(sent.workflowId, sent.runId) }
  if (item.from !== undefined) return null
  if (!chat.workflow && chat.workflowTest === undefined) return null
  const blocks = !item.command && !item.todo && promptParts(item.text).some((p) => p.kind === 'input')
  if (!first && !blocks) return null
  if (chat.workflow) {
    const step = stepName?.trim()
    return step ? { name: chat.workflow.name, step } : { name: chat.workflow.name }
  }
  return { name: `${chat.workflowTest} · step test` }
}

export interface WorkflowMessages {
  /** The user messages a workflow sent. */
  sent: Set<string>
  /** Who sent each of them. */
  senders: Map<string, Sender>
  /** The parts of each message holding an input block (a sent command's never does). */
  parts: Map<string, PromptPart[]>
}

/** The sent messages of a chat's loaded items, and the parts of those holding an input block. Empty in other chats. */
export function workflowMessages(
  chat: Pick<ChatMeta, 'workflow' | 'workflowTest'>,
  items: readonly ChatItem[],
  hasOlder: boolean,
  stepName?: string
): WorkflowMessages {
  const out: WorkflowMessages = { sent: new Set(), senders: new Map(), parts: new Map() }
  let first = !hasOlder
  for (const i of items) {
    if (i.type !== 'user') continue
    const sender = senderOf(i, chat, first, stepName)
    if (i.from === undefined) first = false
    if (!sender) continue
    out.sent.add(i.id)
    out.senders.set(i.id, sender)
    if (i.command || i.todo) continue
    const parts = promptParts(i.text)
    if (parts.some((p) => p.kind === 'input')) out.parts.set(i.id, parts)
  }
  return out
}

/** A fence longer than any backtick run in the text, so a body holding ``` cannot end its code block early. */
export function fenced(text: string, lang: string): string {
  const run = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length))
  const fence = '`'.repeat(Math.max(3, run + 1))
  return `${fence}${lang}\n${text}\n${fence}`
}

/**
 * Material as Markdown: a JSON object or array (a webhook body) stays as written, in a code block. `shown` is the part
 * drawn (a folded preview), judged by the whole text, since a cut preview no longer parses.
 */
export function materialMarkdown(text: string, shown: string = text): string {
  const t = text.trim()
  if (!/^[[{]/.test(t)) return shown
  try {
    JSON.parse(t)
    return fenced(shown, 'json')
  } catch {
    return shown
  }
}
