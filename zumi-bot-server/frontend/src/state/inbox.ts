import type { ApprovalDecision, ChatItem, ChatMeta } from '@zumibot/shared/types'
import { isNewMessage, type InboxMessages, type WorkflowApproval, type WorkflowMessage } from '@zumibot/shared/inbox'
import type { WorkflowsSnapshot } from '@zumibot/shared/workflows'
import { toolSummary } from '@zumibot/shared/toolSummary'
import { PLAN_TOOL } from '@zumibot/shared/plans'
import { parseQuestions, QUESTION_TOOL } from '@zumibot/shared/questions'
import { askedSince, askingOf, unanswered, type TodoItem } from '@zumibot/shared/todos'
import { friendlyText, mentionLabel } from './agentNames'
import type { ApprovalReply } from './approvals'
import { plainTodoText } from './todoLine'

type ApprovalItem = Extract<ChatItem, { type: 'approval' }>
type HandoffItem = Extract<ChatItem, { type: 'browser-action' }>

export type WaitingEntry =
  | { kind: 'card'; key: string; chatId: string; item: ApprovalItem; since: number }
  | { kind: 'handoff'; key: string; chatId: string; item: HandoffItem; since: number }
  | { kind: 'workflow'; key: string; approval: WorkflowApproval; since: number }
  // A board card whose agent asked on it.
  | { kind: 'todo'; key: string; item: TodoItem; since: number }

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const LINE_CUT = 60

const byAge = (a: { since: number; key: string }, b: { since: number; key: string }): number =>
  a.since - b.since || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)

/** The chats whose items the page must load: only those with something waiting. */
export function chatsToLoad(pendingByChat: Record<string, number>): string[] {
  return Object.keys(pendingByChat).filter((id) => pendingByChat[id] > 0)
}

/** chatsToLoad, of the chats this tab knows: a chat not listed (deleted, not pushed yet) has no cards to show. */
export function waitingChats(pendingByChat: Record<string, number>, chats: readonly ChatMeta[]): string[] {
  const listed = new Set(chats.map((c) => c.id))
  return chatsToLoad(pendingByChat).filter((id) => listed.has(id))
}

/**
 * Changes when a waiting chat's count moves or a waiting chat gets listed: the moment to load its items again. Sorted:
 * a count push moves its chat to the end of the map, which must not look like a change of every chat.
 */
export function loadKey(pendingByChat: Record<string, number>, chats: readonly ChatMeta[]): string {
  return waitingChats(pendingByChat, chats)
    .sort()
    .map((id) => `${id}:${pendingByChat[id]}`)
    .join(',')
}

/**
 * A chat's own waiting cards: its count less what its running A→B chats hold, since the server rolls an asked chat's
 * cards up into the asker's count and they live in the asked chat's items, never the asker's.
 */
export function ownPending(chatId: string, pendingByChat: Record<string, number>, chats: readonly ChatMeta[]): number {
  const asked = chats.reduce((n, c) => (c.asked?.from === chatId ? n + (pendingByChat[c.id] ?? 0) : n), 0)
  return Math.max(0, (pendingByChat[chatId] ?? 0) - asked)
}

// Older pages of one chat loaded to find its cards, per count; a bound, so a count no page can explain never loops.
export const OLDER_PAGES_MAX = 10

/** A card can sit above the newest page (a room member waits while others work on): load one more older page. */
export function needsOlder(found: number, count: number, complete: boolean, pagesTried: number): boolean {
  return found < count && !complete && pagesTried < OLDER_PAGES_MAX
}

/**
 * Everything waiting on the user, oldest first. Cards come from each listed chat's own loaded items, so an A→B card
 * shows once, from the asked chat (the asking chat's count includes it but its items hold no such card).
 */
export function waitingEntries(o: {
  chats: readonly ChatMeta[]
  pendingByChat: Record<string, number>
  itemsOf: (chatId: string) => readonly ChatItem[] | undefined
  approvals: readonly WorkflowApproval[]
  /** The board's open items; the cards whose agent waits on an answer get one entry each, however many questions. */
  cards?: readonly TodoItem[]
}): WaitingEntry[] {
  const out: WaitingEntry[] = []
  for (const chat of o.chats) {
    if ((o.pendingByChat[chat.id] ?? 0) <= 0) continue
    for (const item of o.itemsOf(chat.id) ?? []) {
      if (item.type === 'approval' && item.status === 'pending') {
        out.push({ kind: 'card', key: `${chat.id}:${item.id}`, chatId: chat.id, item, since: item.ts })
      } else if (item.type === 'browser-action' && item.handoff.status === 'pending') {
        out.push({ kind: 'handoff', key: `${chat.id}:${item.id}`, chatId: chat.id, item, since: item.ts })
      }
    }
  }
  for (const approval of o.approvals) {
    out.push({ kind: 'workflow', key: `run:${approval.visit.id}`, approval, since: approval.visit.startedAt })
  }
  for (const item of askingOf(o.cards ?? [])) out.push({ kind: 'todo', key: `todo:${item.id}`, item, since: askedSince(item)! })
  return out.sort(byAge)
}

/** The rail's count: hidden at 0, capped at 99+. */
export function countText(n: number): string | null {
  return n <= 0 ? null : n > 99 ? '99+' : String(n)
}

export function waitedText(since: number, now: number): string {
  const age = now - since
  if (age < MINUTE) return 'just now'
  if (age < HOUR) return `waiting ${Math.floor(age / MINUTE)} min`
  if (age < DAY) return `waiting ${Math.floor(age / HOUR)} h`
  return `waiting ${Math.floor(age / DAY)} d`
}

const workflowWhere = (a: WorkflowApproval): string => `${a.workflowName} › ${a.step.name}`

/** An entry's header: `who` is the asking agent's handle (the card shows its display name), `where` reads as shown. */
export function entryHeader(
  e: WaitingEntry,
  chats: readonly ChatMeta[],
  agents: readonly { name: string }[]
): { who: string | null; where: string; link: 'chat' | 'run' | 'todo' } {
  if (e.kind === 'workflow') return { who: null, where: workflowWhere(e.approval), link: 'run' }
  // The card's title: the board is one place, so no list to name.
  if (e.kind === 'todo') return { who: e.item.task?.agent ?? null, where: `“${plainTodoText(e.item.text)}”`, link: 'todo' }
  const chat = chats.find((c) => c.id === e.chatId)
  // A room has no agent of its own: its cards name the member.
  const agent = e.item.agent ?? chat?.agentName ?? ''
  const where = chat?.asked
    ? `asked by ${mentionLabel(chat.asked.by)} in ${friendlyText(chat.asked.fromTitle, agents)}`
    : friendlyText(chat?.title ?? '', agents)
  return { who: agent === '' ? null : agent, where, link: 'chat' }
}

/**
 * What stays in an answered entry's place, so the list does not jump under the cursor and the card cannot be pressed
 * twice. `until` is null while the answer is on its way (the card stays held under the line, its draft kept), then the
 * time the line leaves. no: a refusal, drawn muted.
 */
export interface AnsweredLine {
  key: string
  since: number
  text: string
  until: number | null
  no?: true
}

const cut = (s: string): string => (s.length > LINE_CUT ? s.slice(0, LINE_CUT - 1) + '…' : s)

const DECISION: Record<ApprovalDecision, string> = {
  'allow-once': '✓ Allowed once',
  'allow-chat': '✓ Allowed for this chat',
  'allow-agent': '✓ Allowed always',
  'allow-step': '✓ Allowed for this step',
  deny: '✗ Denied'
}

/** `agent` names who asked when the card does not (a single chat's card is its chat's agent's). */
export function answeredText(
  e: WaitingEntry,
  reply: ApprovalReply | 'approved' | 'rejected' | 'done' | 'cancelled',
  agent: string | null = e.kind === 'workflow' ? null : e.kind === 'todo' ? (e.item.task?.agent ?? null) : (e.item.agent ?? null)
): string {
  if (e.kind === 'workflow') return `${reply === 'rejected' ? '✗ Rejected' : '✓ Approved'} · ${workflowWhere(e.approval)}`
  if (e.kind === 'todo')
    return `✓ Answered · ${cut(unanswered(e.item)[0]?.text.replace(/\s+/g, ' ') ?? plainTodoText(e.item.text))}${agent ? ` · ${mentionLabel(agent)}` : ''}`
  const who = agent ? ` · ${mentionLabel(agent)}` : ''
  if (e.kind === 'handoff') return `${reply === 'cancelled' ? '✗ Cancelled' : '✓ Done'} · ${cut(e.item.handoff.reason)}${who}`
  let head: string
  if (typeof reply === 'string') head = reply in DECISION ? DECISION[reply as keyof typeof DECISION] : '✓ Done'
  else if ('answers' in reply) head = reply.answers === null ? '✗ Skipped' : '✓ Answered'
  else head = reply.plan.approve ? '✓ Plan approved' : '✗ Plan sent back'
  // A question reads as its first question; a plan's text is too long to say anything in one line.
  const what =
    e.item.toolName === PLAN_TOOL
      ? null
      : e.item.toolName === QUESTION_TOOL
        ? (parseQuestions(e.item.input)?.questions[0]?.text ?? null)
        : toolSummary(e.item.toolName, e.item.input)
  return `${head}${what === null ? '' : ` · ${cut(what)}`}${who}`
}

/** What the user pressed on an entry: a chat card's reply, a handoff's I'm done / Cancel, or a workflow approval. */
export type InboxAnswer =
  | { kind: 'card'; reply: ApprovalReply }
  | { kind: 'handoff'; decision: 'done' | 'cancel' }
  | { kind: 'workflow'; ok: boolean; text?: string; note?: string }
  | { kind: 'todo'; answers: { id: string; text: string }[] }

export const ANSWERED_MS = 4_000

const replyOf = (a: InboxAnswer): ApprovalReply | 'approved' | 'rejected' | 'done' | 'cancelled' =>
  a.kind === 'card'
    ? a.reply
    : a.kind === 'handoff'
      ? a.decision === 'done'
        ? 'done'
        : 'cancelled'
      : a.kind === 'todo'
        ? 'done'
        : a.ok
          ? 'approved'
          : 'rejected'

const refused = (a: InboxAnswer): boolean =>
  a.kind === 'todo'
    ? false
    : a.kind === 'workflow'
      ? !a.ok
      : a.kind === 'handoff'
        ? a.decision === 'cancel'
        : typeof a.reply === 'string'
          ? a.reply === 'deny'
          : 'answers' in a.reply
            ? a.reply.answers === null
            : !a.reply.plan.approve

/** The line an entry answered here leaves in its place, naming the agent the header names; held until its send settles. */
export function answeredLine(e: WaitingEntry, a: InboxAnswer, chats: readonly ChatMeta[]): AnsweredLine {
  const who = entryHeader(e, chats, []).who
  const text = answeredText(e, replyOf(a), who)
  return { key: e.key, since: e.since, text, until: null, ...(refused(a) ? { no: true as const } : {}) }
}

/** The press: the line takes the entry's place at once (one line per entry). */
export function pressAnswer(lines: readonly AnsweredLine[], line: AnsweredLine): AnsweredLine[] {
  return [...lines.filter((l) => l.key !== line.key), line]
}

/**
 * The send settled. A success keeps the line ANSWERED_MS from now (a slow send never lets the card back early); a
 * failure drops it, so the same card shows again with what was typed in it.
 */
export function settleAnswer(lines: readonly AnsweredLine[], key: string, ok: boolean, now: number): AnsweredLine[] {
  if (!lines.some((l) => l.key === key && l.until === null)) return [...lines]
  return ok
    ? lines.map((l) => (l.key === key && l.until === null ? { ...l, until: now + ANSWERED_MS } : l))
    : lines.filter((l) => l.key !== key)
}

const isLive = (l: AnsweredLine, now: number): boolean => l.until === null || l.until > now

/** The lines still showing: every held one, and the settled ones not yet expired. */
export function liveLines(lines: readonly AnsweredLine[], now: number): AnsweredLine[] {
  return lines.filter((l) => isLive(l, now))
}

/** How long until the next settled line expires, so the page redraws then; null when none will. */
export function nextExpiry(lines: readonly AnsweredLine[], now: number): number | null {
  const ends = lines.flatMap((l) => (l.until !== null && l.until > now ? [l.until] : []))
  return ends.length === 0 ? null : Math.min(...ends) - now
}

// An answered row carries its entry while it is still listed, so the card stays mounted (hidden) under the line.
export type InboxRow = { kind: 'entry'; entry: WaitingEntry } | { kind: 'answered'; line: AnsweredLine; entry: WaitingEntry | null }

/** Waiting entries and the still-live answered lines in one age order; a key with a live line is never shown twice. */
export function inboxRows(entries: readonly WaitingEntry[], answered: readonly AnsweredLine[], now: number): InboxRow[] {
  const live = liveLines(answered, now)
  const held = new Set(live.map((l) => l.key))
  const rows: Array<InboxRow & { since: number; key: string }> = [
    ...entries.filter((e) => !held.has(e.key)).map((entry) => ({ kind: 'entry' as const, entry, since: entry.since, key: entry.key })),
    ...live.map((line) => ({
      kind: 'answered' as const,
      line,
      entry: entries.find((e) => e.key === line.key) ?? null,
      since: line.since,
      key: line.key
    }))
  ]
  return rows.sort(byAge).map(({ since: _s, key: _k, ...row }) => row as InboxRow)
}

/** One key per entry whether it shows as its card or as its answered line, so the card keeps its state across the two. */
export const rowKey = (r: InboxRow): string => (r.kind === 'entry' ? r.entry.key : r.line.key)

export type InboxFilter = 'all' | 'waiting' | 'messages'

/**
 * The Messages view. `heldSeenAt` is the seenAt from when the page opened, so what was new stays marked while it is
 * read; the server's own seenAt moves on. A run is gone when its workflow or its entry in the kept runs is.
 */
export function messageView(
  m: InboxMessages,
  heldSeenAt: number,
  runs: WorkflowsSnapshot
): {
  shown: Array<WorkflowMessage & { isNew: boolean; runGone: boolean }>
  archived: Array<WorkflowMessage & { runGone: boolean }>
  newCount: number
} {
  const newest = (a: WorkflowMessage, b: WorkflowMessage): number => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const runGone = (x: WorkflowMessage): boolean =>
    !runs.workflows.some((w) => w.id === x.workflowId) || !(runs.runs[x.workflowId] ?? []).some((r) => r.id === x.runId)
  const sorted = [...m.messages].sort(newest)
  const shown = sorted
    .filter((x) => x.archivedAt === undefined)
    .map((x) => ({ ...x, isNew: isNewMessage(x, heldSeenAt), runGone: runGone(x) }))
  const archived = sorted.filter((x) => x.archivedAt !== undefined).map((x) => ({ ...x, runGone: runGone(x) }))
  return { shown, archived, newCount: shown.filter((x) => x.isNew).length }
}

/** The rail's dot: something new that is not archived, by the server's own seenAt. */
export function anyNewMessage(m: InboxMessages | null): boolean {
  return m !== null && m.messages.some((x) => isNewMessage(x, m.seenAt))
}

/**
 * What to send to `inbox:seen`, or null: the newest message's own time, which is the server's clock (this tab's may be
 * behind or ahead), and only while the Messages section shows and some message is past seenAt. `seen` broadcasts
 * `inbox:changed`, which refetches, which would ask again; the server clamps to its own now, so a time it clamped stays
 * behind: `sent` (the last time sent this visit) makes each time go once, and nothing can loop.
 */
export function seenToSend(m: InboxMessages | null, shown: boolean, sent: number | null): number | null {
  if (!shown || m === null) return null
  const behind = m.messages.filter((x) => x.at > m.seenAt)
  if (behind.length === 0) return null
  const at = Math.max(...behind.map((x) => x.at))
  return at === sent ? null : at
}

/** The chip when the page opens: All from closed or for a named message (spec: All each time it opens), else as it was. */
export function filterOnOpen(current: InboxFilter, wasOpen: boolean, messageId: string | null): InboxFilter {
  return !wasOpen || messageId !== null ? 'all' : current
}

/**
 * What a message the address named needs now: lit once it is on screen (an archived one unfolds first); a hidden
 * section or a message not in the list yet (a click right after the broadcast, before the refetch) waits rather than
 * dropping the id.
 */
export function focusStep(
  focusId: string | null,
  lit: string | null,
  shown: boolean,
  ids: { shown: readonly string[]; archived: readonly string[] },
  showArchived: boolean
): 'none' | 'wait' | 'unfold' | 'light' {
  if (focusId === null || lit === focusId) return 'none'
  if (!shown) return 'wait'
  if (ids.archived.includes(focusId)) return showArchived ? 'light' : 'unfold'
  return ids.shown.includes(focusId) ? 'light' : 'wait'
}

/**
 * The seenAt kept while the page is open, so what was new stays marked while it is read (spec goal 14): captured from
 * the first answer after the page opens, dropped when it is left.
 */
export function heldSeenAt(held: number | null, open: boolean, m: InboxMessages | null): number | null {
  if (!open) return null
  return held ?? m?.seenAt ?? null
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** "10:42" today, "yesterday 10:42", else "3 Nov 10:42" (with the year when it is not this one). */
export function messageTime(at: number, now: number): string {
  const d = new Date(at)
  const n = new Date(now)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const day = (x: Date): number => Date.UTC(x.getFullYear(), x.getMonth(), x.getDate())
  const days = Math.round((day(n) - day(d)) / 86_400_000)
  if (days === 0) return hm
  if (days === 1) return `yesterday ${hm}`
  const month = d.toLocaleString('en', { month: 'short' })
  return `${d.getDate()} ${month}${d.getFullYear() === n.getFullYear() ? '' : ` ${d.getFullYear()}`} ${hm}`
}
