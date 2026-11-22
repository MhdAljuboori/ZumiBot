import {
  BTW_NAME,
  SIDE_ASK_FIRST_TEXT,
  SIDE_MAX_OPEN,
  SIDE_WAIT_TEXT,
  askedByText,
  isOpen,
  sideParts,
  sourceGoneText,
  type SideAskLink,
  type SideQuestion
} from '@zumibot/shared/btw'
import { COMMAND_PROMPT_MAX } from '@zumibot/shared/commands'
import { displayName } from '@zumibot/shared/frontmatter'
import { runWorkflowRest } from '@zumibot/shared/runWorkflow'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import { mentionLabel } from './agentNames'

const LEAD_BTW = new RegExp(`^/${BTW_NAME}(?=\\s|$)`)

export function upsertSide(list: readonly SideQuestion[], entry: SideQuestion): SideQuestion[] {
  const found = list.some((q) => q.id === entry.id)
  return panelOrder(found ? list.map((q) => (q.id === entry.id ? entry : q)) : [...list, entry])
}

export function chipText(q: SideQuestion, max = 48): string {
  const chars = Array.from(q.question)
  return `btw · ${chars.length > max ? chars.slice(0, max).join('') + '…' : q.question}`
}

export function panelOrder(list: readonly SideQuestion[]): SideQuestion[] {
  return [...list].sort((a, b) => a.askedAt - b.askedAt)
}

export interface PickChip {
  key: string // 'auto', 'both' or `agent:${name}`
  label: string
  agent: string | null
  disabled: string | null // the reason, shown as the chip's title; null = usable
}

/** The "Answer from" chips: none for a single chat, Auto + loadable members for a room, B / A / Both for an asked chat. */
export function pickChips(
  chat: ChatMeta,
  agents: readonly AgentSummary[],
  sourceExists: boolean,
  list: readonly SideQuestion[]
): PickChip[] {
  if (chat.group) {
    const loads = new Set(agents.filter((a) => a.error === null).map((a) => a.name))
    return [
      { key: 'auto', label: 'Auto', agent: null, disabled: null },
      ...chat.group.members.filter((m) => loads.has(m)).map((m) => ({ key: `agent:${m}`, label: displayName(m), agent: m, disabled: null }))
    ]
  }
  if (!chat.asked) return []
  const by = chat.asked.by
  const gone = sourceExists ? null : sourceGoneText(by)
  const free = SIDE_MAX_OPEN - list.filter(isOpen).length
  return [
    { key: `agent:${chat.agentName}`, label: displayName(chat.agentName), agent: chat.agentName, disabled: null },
    { key: `agent:${by}`, label: displayName(by), agent: by, disabled: gone },
    { key: 'both', label: 'Both', agent: null, disabled: gone ?? (free < 2 ? 'Both needs 2 free side question slots' : null) }
  ]
}

/** The questions to send for a pick, in order. A typed leading @handle wins over the pick; the chat's own agent gets no mention. */
export function sideTexts(chat: ChatMeta, key: string, text: string): string[] {
  const parts = sideParts(text)
  if (!parts) return []
  if (parts.mention) return [`@${parts.mention} ${parts.question}`]
  const as = (agent: string) => `@${agent} ${parts.question}`
  if (key === 'both' && chat.asked) return [parts.question, as(chat.asked.by)]
  if (key.startsWith('agent:')) {
    const agent = key.slice('agent:'.length)
    return [agent === chat.agentName ? parts.question : as(agent)]
  }
  return [parts.question]
}

/** The server refuses a body past the limit, and the mention a pick adds counts: check before the first call so Both never half-sends. */
export function tooLong(texts: readonly string[]): boolean {
  return texts.some((t) => t.length > COMMAND_PROMPT_MAX)
}

export function routeSend(text: string): { kind: 'btw'; question: string } | { kind: 'workflow' } | { kind: 'send' } {
  const command = LEAD_BTW.exec(text)
  if (command) return { kind: 'btw', question: text.slice(command[0].length).trim() }
  // The whole text goes to the server, which takes off the command and resolves the workflow's name, so nothing is cut here.
  return runWorkflowRest(text) !== null ? { kind: 'workflow' } : { kind: 'send' }
}

/** The island has no side panel to show an answer in, so a typed leading `/btw` there is refused: the notice to show, else null. */
export function btwRefusal(text: string, notice: string | undefined): string | null {
  return notice !== undefined && routeSend(text).kind === 'btw' ? notice : null
}

/** A place that cannot start a workflow (the island, the new-chat screen) refuses a typed leading `/run-workflow`: the notice to show, else null. */
export function workflowRefusal(text: string, notice: string | undefined): string | null {
  return notice !== undefined && routeSend(text).kind === 'workflow' ? notice : null
}

const LINK_STATE: Record<SideAskLink['state'], string> = { running: 'Asking…', done: 'Done', error: 'Failed', stopped: 'Stopped' }

export function askLinkText(link: SideAskLink): string {
  return `Side question to ${mentionLabel(link.agent)} · ${LINK_STATE[link.state]}`
}

/** A root question and its follow-ups, which stay in one conversation. */
export interface SideThread {
  id: string // the root's id
  root: SideQuestion
  entries: SideQuestion[] // oldest first
  last: SideQuestion
  open: boolean
  status: 'running' | 'done' | 'error' | 'stopped'
}

/** An entry whose `thread` names no listed entry (its root was lost) stands alone as its own root. */
export function sideThreads(list: readonly SideQuestion[]): SideThread[] {
  const ids = new Set(list.map((q) => q.id))
  const byRoot = new Map<string, SideQuestion[]>()
  for (const q of panelOrder(list)) {
    const root = q.thread !== undefined && ids.has(q.thread) ? q.thread : q.id
    const entries = byRoot.get(root)
    if (entries) entries.push(q)
    else byRoot.set(root, [q])
  }
  const threads: SideThread[] = []
  for (const [id, entries] of byRoot) {
    const root = entries.find((q) => q.id === id) ?? entries[0]
    const last = entries[entries.length - 1]
    const open = entries.some(isOpen)
    // Not open means the last entry is finished, so its state is never picking or running.
    threads.push({ id, root, entries, last, open, status: open ? 'running' : (last.state as SideThread['status']) })
  }
  return threads.sort((a, b) => a.root.askedAt - b.root.askedAt)
}

export const threadOf = (threads: readonly SideThread[], entryId: string): SideThread | undefined =>
  threads.find((t) => t.entries.some((q) => q.id === entryId))

export function threadLine(t: SideThread): { text: string; tone: 'live' | 'error' | 'muted' } {
  const { last } = t
  if (t.open)
    return { text: last.state === 'picking' ? 'Picking who answers…' : last.thread ? 'Answering follow-up…' : 'Answering…', tone: 'live' }
  if (last.state === 'error') return { text: last.error ?? 'Could not answer', tone: 'error' }
  if (last.state === 'stopped') return { text: 'Stopped', tone: 'muted' }
  return {
    text:
      last.answer
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l !== '') ?? '',
    tone: 'muted'
  }
}

export interface ThreadGroup {
  key: string // the chat item the roots were asked after, else 'start'
  label: string
  rows: SideThread[]
}

/** Roots grouped by the reply they were asked after: newest group first, newest root first, the first group is "This reply". */
export function groupThreads(threads: readonly SideThread[], fmtTime: (ms: number) => string): ThreadGroup[] {
  const byKey = new Map<string, SideThread[]>()
  for (const t of [...threads].sort((a, b) => b.root.askedAt - a.root.askedAt)) {
    const key = t.root.after ?? 'start'
    const rows = byKey.get(key)
    if (rows) rows.push(t)
    else byKey.set(key, [t])
  }
  // Rows are newest first, so a group's first row sets its place and its last row is its oldest.
  return [...byKey].map(([key, rows], i) => ({
    key,
    rows,
    label: i === 0 ? 'This reply' : fmtTime(rows[rows.length - 1].root.askedAt)
  }))
}

/** Why a follow-up cannot be asked now (the server checks the same, in this order), or null. */
export function canFollow(t: SideThread, chat: ChatMeta, sourceExists: boolean): string | null {
  const { root } = t
  if (root.from) return askedByText(root.from)
  if (t.open) return SIDE_WAIT_TEXT
  if (root.agent === null) return SIDE_ASK_FIRST_TEXT
  if (chat.asked && root.mention && !sourceExists) return sourceGoneText(root.agent)
  return null
}

// An entry an agent asked is rerun by that agent's own ask, never from here; only a thread's last entry reruns.
export function canAskAgain(entry: SideQuestion, t: SideThread): boolean {
  return entry.id === t.last.id && (entry.state === 'error' || entry.state === 'stopped') && !entry.from
}

export const threadCountText = (t: SideThread): string | null => (t.entries.length >= 2 ? `${t.entries.length} questions` : null)
