import { isAskTool } from '@zumibot/shared/agentAsk'
import type { ChatItem } from '@zumibot/shared/types'
import type { SideQuestion } from '@zumibot/shared/btw'
import { sideThreads, type SideThread } from './sideQuestions'

export type AgentItem = Extract<ChatItem, { type: 'assistant' | 'thinking' | 'tool' | 'approval' | 'browser-action' | 'vault-approval' }>

export type MessageRow =
  | { kind: 'user'; key: string; item: Extract<ChatItem, { type: 'user' }> }
  | { kind: 'agent'; key: string; items: AgentItem[]; agent: string | null; ack?: string } // agent: the author in a group chat, else null; ack: see withAcks
  | { kind: 'other'; key: string; item: Extract<ChatItem, { type: 'notice' | 'error' }> }
  | { kind: 'side'; key: string; thread: SideThread }

/** Agent groups are keyed by the row before them: the live group shown before its first item lands keeps its key. */
export const agentKeyAfter = (prevKey: string | null): string => `agent-after:${prevKey ?? 'start'}`

/** Runs of agent output (text, tool calls, approvals) become one group shown under the agent's name and icon. */
export function groupItems(items: readonly ChatItem[], sides: readonly SideQuestion[] = [], fromStart = true): MessageRow[] {
  const rows: MessageRow[] = []
  // One chip per thread, at its root's anchor: follow-ups add no row of their own.
  const after = new Map<string | null, SideThread[]>()
  for (const thread of sideThreads(sides)) {
    const anchored = after.get(thread.root.after)
    if (anchored) anchored.push(thread)
    else after.set(thread.root.after, [thread])
  }
  const appendSides = (anchor: string | null): void => {
    for (const thread of after.get(anchor) ?? []) rows.push({ kind: 'side', key: `side:${thread.id}`, thread })
  }
  if (fromStart) appendSides(null)
  for (const item of items) {
    if (item.type === 'user') {
      rows.push({ kind: 'user', key: item.id, item })
    } else if (item.type === 'notice' && item.kind === 'kept') {
      // Older chats stored a notice after an edit ("Version 1 ran 3 commands…"); it is no longer shown.
    } else if (item.type === 'notice' || item.type === 'error') {
      rows.push({ kind: 'other', key: item.id, item })
    } else {
      const last = rows[rows.length - 1]
      const author = item.agent ?? null
      if (last?.kind === 'agent' && last.agent === author) last.items.push(item)
      else rows.push({ kind: 'agent', key: agentKeyAfter(last?.key ?? null), items: [item], agent: author })
    }
    appendSides(item.id)
  }
  return rows
}

/**
 * A single chat's ack line (the user item's `ack`) opens the agent group right after its message. Before the reply's first
 * item lands, it gets a group of its own, under the same key that reply's group will have, so the live tail joins it.
 */
export function withAcks(rows: readonly MessageRow[]): MessageRow[] {
  const out: MessageRow[] = []
  rows.forEach((row, i) => {
    const prev = out[out.length - 1]
    if (row.kind === 'agent' && row.agent === null && prev?.kind === 'user' && prev.item.ack) {
      out.push({ ...row, ack: prev.item.ack })
      return
    }
    out.push(row)
    const next = rows[i + 1]
    if (row.kind === 'user' && row.item.ack && !(next?.kind === 'agent' && next.agent === null))
      out.push({ kind: 'agent', key: agentKeyAfter(row.key), items: [], agent: null, ack: row.item.ack })
  })
  return out
}

/** The row holding an item (an agent row holds several), else -1. */
export function rowIndexOf(rows: readonly MessageRow[], itemId: string): number {
  return rows.findIndex((r) => (r.kind === 'agent' ? r.items.some((i) => i.id === itemId) : r.kind !== 'side' && r.item.id === itemId))
}

/** The last row that is not a side chip, else -1: a chip asked after a paused notice must not take its Continue. */
export function lastContentRow(rows: readonly MessageRow[]): number {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].kind !== 'side') return i
  return -1
}

type ToolItem = Extract<AgentItem, { type: 'tool' }>
export type ThinkingItem = Extract<AgentItem, { type: 'thinking' }>
/** What a run folds: tool calls and the thinking between them. */
export type RunItem = ToolItem | ThinkingItem

export type AgentBlock =
  | { kind: 'item'; key: string; item: Exclude<AgentItem, RunItem> | ToolItem } // a tool item here is an ask or side_question call
  | { kind: 'tools'; key: string; tools: RunItem[]; ms: number }

/**
 * Back-to-back tool calls in a group fold into one block, so a long run reads as one "Thought for Xs" row. The agent's
 * thinking folds in with them: it is what the run's row is named for, and a lone one makes a run of its own.
 * An ask or side_question call to another agent stands alone: it is drawn as a card, and ends the run before it.
 * A run is timed from its first call to the item after it, else to its latest result (else its last call's start).
 */
export function foldTools(items: readonly AgentItem[]): AgentBlock[] {
  const blocks: AgentBlock[] = []
  let run: RunItem[] = []
  const close = (next: AgentItem | undefined) => {
    if (run.length === 0) return
    const end = next?.ts ?? Math.max(...run.map((t) => t.doneTs ?? t.ts))
    blocks.push({ kind: 'tools', key: `tools:${run[0].id}`, tools: run, ms: end - run[0].ts })
    run = []
  }
  for (const item of items) {
    if (item.type === 'thinking' || (item.type === 'tool' && !isAskTool(item.name))) {
      run.push(item)
    } else {
      close(item)
      blocks.push({ kind: 'item', key: item.id, item })
    }
  }
  close(undefined)
  return blocks
}

/**
 * The chat's latest output is a tool run, so while the chat runs the agent is still thinking. A running ask has its own
 * spinner, but one that returned is drawn as a Done card, which does not move: the line must show.
 */
export function endsInTools(rows: readonly MessageRow[]): boolean {
  const last = rows[rows.length - 1]
  return last?.kind === 'agent' && endsInToolItems(last.items)
}

/** endsInTools for one agent group's items (a room's live turn). Thinking that just ended is followed by more of the turn. */
export function endsInToolItems(items: readonly AgentItem[]): boolean {
  const item = items[items.length - 1]
  if (item?.type === 'thinking') return true
  if (item?.type !== 'tool') return false
  return !(isAskTool(item.name) && item.result !== null && item.result !== undefined)
}

export function thoughtLabel(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `Thought for ${s}s`
  const m = Math.floor(s / 60)
  return s % 60 === 0 ? `Thought for ${m}m` : `Thought for ${m}m ${s % 60}s`
}

/**
 * One line of a thinking summary for a row that has room for one, with Markdown emphasis and heading marks dropped (the row
 * shows plain text): the latest paragraph while it streams (what the agent is on now), the first once it is kept (what it
 * set out to do). Empty for blank text.
 */
export function thoughtPreview(text: string, which: 'first' | 'last' = 'last'): string {
  const lines = text
    .split('\n')
    .map((l) =>
      l
        .replace(/^#+\s+/, '')
        .replace(/\*\*|__/g, '')
        .trim()
    )
    .filter((l) => l !== '')
  return (which === 'first' ? lines[0] : lines[lines.length - 1]) ?? ''
}

/** A kept thought's row title: how long it took, when its start and end were both seen. */
export function thoughtTitle(item: { ts: number; doneTs?: number }): string {
  return item.doneTs !== undefined && item.doneTs > item.ts ? thoughtLabel(item.doneTs - item.ts) : 'Thought'
}
