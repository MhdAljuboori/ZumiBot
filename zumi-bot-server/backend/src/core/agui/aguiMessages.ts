import { AGUI_TEXT } from '@zumibot/shared/agui'
import type { ChatItem, SessionCut } from '@zumibot/shared/types'
import { markEngine } from '@zumibot/shared/engine'
import { AGUI_TOOL } from './aguiEvents'

// The history a remote agent gets, which the protocol requires on every run. Pure. Only the user's messages, the agent's
// replies and the remote tool rows of earlier AG-UI turns go out: never thinking, notices, errors, cards, attachments, or
// a row a local engine made. A chat that holds another engine's turn is refused before this runs (`foreignHistory`).

export interface AguiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}
export type AguiMessage =
  | { id: string; role: 'user'; content: string }
  | { id: string; role: 'assistant'; content?: string; toolCalls?: AguiToolCall[] }
  | { id: string; role: 'tool'; toolCallId: string; content: string; error?: string }

/** The server's id of a row's call: what follows the first `:` (the runner tags each id with its attempt). */
export function untag(id: string): string {
  const i = id.indexOf(':')
  return i < 0 ? id : id.slice(i + 1)
}

type ToolItem = Extract<ChatItem, { type: 'tool' }>
type Obj = Record<string, unknown>

// A remote tool row as the call it was, or null for any other row.
function callOf(it: ToolItem): AguiToolCall | null {
  const input = it.input as Obj | null
  if (it.name !== AGUI_TOOL || input === null || typeof input !== 'object' || typeof input.tool !== 'string') return null
  const args = typeof input.argsText === 'string' ? input.argsText : (JSON.stringify(input.args) ?? '')
  return { id: untag(it.id), type: 'function', function: { name: input.tool, arguments: args } }
}

// A failed or unfinished call says so in `error`; an empty error would read as none, so it falls back to toolUnfinished.
function resultOf(it: ToolItem): AguiMessage {
  const failed = it.isError || it.result === null
  return {
    id: `result-${it.id}`,
    role: 'tool',
    toolCallId: untag(it.id),
    content: it.result ?? '',
    ...(failed ? { error: it.result || AGUI_TEXT.toolUnfinished } : {})
  }
}

/**
 * The run's `messages` from the chat's visible items, as the agent reads them: the caller fills each message's command and
 * puts its reply quote in front (`withReplies(withCommands(...))`), the turn's own message too, so a message is sent the same
 * text by every run. Tool rows after a reply are its `toolCalls`, each answered by a tool message; a tool run with no reply
 * before it gets an assistant message of its own.
 */
export function aguiMessages(items: readonly ChatItem[]): AguiMessage[] {
  const out: AguiMessage[] = []
  // The message the next tool rows join, and the tool messages that follow it once its run ends.
  let calling: Extract<AguiMessage, { role: 'assistant' }> | null = null
  let results: AguiMessage[] = []
  const endRun = () => {
    out.push(...results)
    results = []
    calling = null
  }
  for (const it of items) {
    if (it.type === 'user') {
      endRun()
      out.push({ id: it.id, role: 'user', content: it.text })
    } else if (it.type === 'assistant') {
      endRun()
      calling = { id: it.id, role: 'assistant', content: it.text }
      out.push(calling)
    } else if (it.type === 'tool') {
      const call = callOf(it)
      if (call === null) continue
      if (calling === null) {
        // The server's call id, as the run's transcript names this message, so one message keeps one id.
        calling = { id: `calls-${call.id}`, role: 'assistant' }
        out.push(calling)
      }
      ;(calling.toolCalls ??= []).push(call)
      results.push(resultOf(it))
    }
  }
  endRun()
  return out
}

// A stamp with no mark is Claude's, so only an AG-UI mark is ours.
const ours = (stamp: SessionCut): boolean => markEngine(stamp.engine) === 'ag-ui'

/**
 * Whether the chat holds a turn another engine ran, whose history must never reach a remote host: a stretch between two
 * messages that holds work (a reply, thinking or a tool row) with no AG-UI end stamp, or any end or cut stamp of another
 * engine. A message's own stamp is its turn's, when that turn left no item. A message with the AG-UI mark counts as its
 * stretch's end stamp: the mark is saved before the turn's first request, while the stamp waits for the turn to end, so a
 * turn a hard crash cut short (its rows saved, then only an `interrupted` notice) is still this engine's.
 */
export function foreignHistory(items: readonly ChatItem[]): boolean {
  let work = false
  let ended = false
  let other = false
  for (const it of items) {
    if (it.type === 'user') {
      if ((work && !ended) || other) return true
      work = other = false
      ended = it.engine === 'ag-ui'
    }
    if (it.type === 'assistant' || it.type === 'thinking' || it.type === 'tool') work = true
    if (it.end !== undefined) {
      if (ours(it.end)) ended = true
      else other = true
    }
    if (it.type === 'assistant' && it.cut !== undefined && !ours(it.cut)) other = true
  }
  return (work && !ended) || other
}
