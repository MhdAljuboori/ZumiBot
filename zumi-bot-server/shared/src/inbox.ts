import type { Step, Visit } from './workflows'

/** A workflow Notify step's message, kept in the Inbox. */
export interface WorkflowMessage {
  id: string // the Notify visit's id, so a second add of the same visit is a no-op
  workflowId: string
  workflowName: string
  runId: string
  stepName: string
  title: string
  body?: string
  at: number // when the step fired
  archivedAt?: number
  deletedAt?: number // tombstone; title/body are emptied once STRIP_AFTER_MS passed
  updatedAt: number // bumped by archive, unarchive, delete, restore: sync's per-message winner
}

export interface WorkflowMessagesFile {
  v: 1
  seenAt: number
  messages: WorkflowMessage[]
}

/** What the list RPC returns: tombstones left out. */
export interface InboxMessages {
  messages: WorkflowMessage[]
  seenAt: number
}

export type NewWorkflowMessage = Omit<WorkflowMessage, 'archivedAt' | 'deletedAt' | 'updatedAt'>

export const INBOX_KEPT = 500
// Sync never deletes, so a tombstone must outlive any machine that still holds the message.
export const TOMBSTONE_KEEP_MS = 365 * 86_400_000
export const UNDO_MS = 6_000
export const STRIP_AFTER_MS = 60_000 // server-side slack over the 6 s toast

/** Strips old tombstones' text, drops very old ones, and keeps the newest INBOX_KEPT live messages. */
export function pruneMessages(f: WorkflowMessagesFile, now: number): WorkflowMessagesFile {
  const live = f.messages.filter((m) => m.deletedAt === undefined)
  // Stable: ties on `at` keep their stored order.
  const newest = new Set(
    live
      .map((m, i) => ({ m, i }))
      .sort((a, b) => b.m.at - a.m.at || a.i - b.i)
      .slice(0, INBOX_KEPT)
      .map((x) => x.m)
  )
  const messages: WorkflowMessage[] = []
  for (const m of f.messages) {
    if (m.deletedAt === undefined) {
      if (newest.has(m)) messages.push(m)
      continue
    }
    const age = now - m.deletedAt
    if (age > TOMBSTONE_KEEP_MS) continue
    if (age > STRIP_AFTER_MS) {
      const { body: _body, ...rest } = m
      messages.push({ ...rest, title: '' })
    } else messages.push(m)
  }
  return { ...f, messages }
}

export function isNewMessage(m: WorkflowMessage, seenAt: number): boolean {
  return m.at > seenAt && m.archivedAt === undefined && m.deletedAt === undefined
}

/** A run's Approval waiting for the user, with the step as the run's snapshot has it. */
export interface WorkflowApproval {
  workflowId: string
  workflowName: string
  runId: string
  visit: Visit // the waiting Approval visit only
  step: Extract<Step, { kind: 'approval' }>
}
