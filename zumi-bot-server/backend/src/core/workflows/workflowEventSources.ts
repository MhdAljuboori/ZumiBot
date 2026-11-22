import type { ChatMeta } from '@zumibot/shared/types'
import type { TurnEnd } from '@zumibot/shared/notify'
import type { TodoItem } from '@zumibot/shared/todos'
import type { WorkflowMessage } from '@zumibot/shared/inbox'
import { REPLY_TEXT_MAX, type ChatRef, type WorkflowEvent } from '@zumibot/shared/workflowEvents'

const chatRef = (m: ChatMeta): ChatRef => ({ id: m.id, title: m.title, folder: m.cwd })

/**
 * A reply that ended, as an event; null when it is no news: a stop, an Agent step's reply (the run reports for itself),
 * an asked chat, or a room member that passed. `room` is which hook fired, so a room's turn is reported once, by its own hook.
 */
export function replyEvent(e: TurnEnd & { passed?: boolean }, meta: ChatMeta | null, room: boolean): WorkflowEvent | null {
  if (!meta || e.outcome === 'stopped' || e.workflow || e.asked || e.passed) return null
  // ChatService's hook also fires for a room's turns; the room's hook reports them.
  if (!room && meta.group) return null
  return {
    kind: 'reply',
    body: { chat: chatRef(meta), agent: e.agent, outcome: e.outcome, room, reply: (e.reply ?? '').slice(0, REPLY_TEXT_MAX) }
  }
}

export function todoEvent(meta: ChatMeta | null, items: TodoItem[], by: string): WorkflowEvent | null {
  if (!meta || items.length === 0) return null
  return {
    kind: 'todo',
    body: { chat: chatRef(meta), by, count: items.length, todos: items.map((i) => ({ text: i.text, group: i.group })) }
  }
}

export function inboxEvent(m: WorkflowMessage): WorkflowEvent {
  return {
    kind: 'inbox',
    body: {
      message: { id: m.id, title: m.title, body: m.body ?? '' },
      workflow: { id: m.workflowId, name: m.workflowName },
      step: m.stepName,
      runId: m.runId
    }
  }
}
