// Pure on purpose (no Node or DOM): the backend, the UI and the service worker all bundle it.
import { displayName } from './agentName'
import { NOTIFY_BODY_MAX } from './workflows'

export type NotifyKind = 'waiting' | 'replied' | 'error' | 'routine-failed'
// spend-cap: a spend cap paused a run, a routine's chat or an agent's day (spendCaps.ts); sent under the `waiting` toggle.
export type NotifyPayloadKind = NotifyKind | 'test' | 'paused' | 'workflow' | 'spend-cap'

export interface NotifyToggles {
  waiting: boolean
  replied: boolean
  error: boolean
  routineFailed: boolean
}

export const DEFAULT_TOGGLES: NotifyToggles = { waiting: true, replied: true, error: true, routineFailed: true }

/** A paired channel (Telegram, Slack) as a notification target: push's four kinds plus a workflow's Notify step. */
export interface ChannelNotifyToggles extends NotifyToggles {
  workflow: boolean
}
/** Off until turned on: a notification to a channel leaves the machine. */
export const DEFAULT_CHANNEL_TOGGLES: ChannelNotifyToggles = {
  waiting: false,
  replied: false,
  error: false,
  routineFailed: false,
  workflow: false
}

export function isChannelToggles(v: unknown): v is ChannelNotifyToggles {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const o = v as Record<string, unknown>
  const keys = Object.keys(DEFAULT_CHANNEL_TOGGLES)
  return Object.keys(o).length === keys.length && keys.every((k) => typeof o[k] === 'boolean')
}

/**
 * A notification as a channel message: the same words as a push (title and what happened), never prompt text, tool input,
 * answers or paths. A Notify step's own text stays in the Inbox: only its title goes.
 */
export function channelNotifyText(p: NotifyPayload): { title: string; line: string } {
  const t = notifyText(p)
  if (p.kind === 'workflow') return { title: t.title, line: 'A workflow sent you a message. It is in the Inbox.' }
  return { title: t.title, line: t.body }
}

export type NotifyChannel = 'push' | 'desktop'

export interface NotifyPayload {
  v: 1
  kind: NotifyPayloadKind
  tag: string
  chatId: string | null
  title: string
  agent?: string
  at: number
  run?: { workflowId: string; runId: string } // the workflow run it is about: a click opens it
  body?: string // a workflow's Notify step's own text, or a spend cap's amounts
  message?: string // a Notify step's Inbox message id: a click opens it (workflow kind only)
  inbox?: true // a task card's question waits in the Inbox: a click opens it (waiting kind only)
}

export const PAYLOAD_KEYS: readonly string[] = ['v', 'kind', 'tag', 'chatId', 'title', 'agent', 'at', 'run', 'body', 'message', 'inbox']

/** notify:clear closes a chat's notifications, or with `tag` (a workflow run's, which has no chat) just that one. */
export interface NotifyClear {
  chatId: string | null
  waitingOnly: boolean
  tag?: string
}

export interface DeviceSummary {
  id: string
  label: string
  channel: NotifyChannel
  toggles: NotifyToggles
  lastSeenAt: number
  subscribed: boolean
  paused: boolean
  current: boolean
}

export interface NotifyStatus {
  pushAvailable: boolean
  vapidPublicKey: string | null
  devices: DeviceSummary[]
}

export interface NotifyState {
  pending: Record<string, number>
  lookedAt: Record<string, number>
}

export interface SubscriptionInput {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export interface TurnEnd {
  chatId: string
  agent: string
  outcome: 'ok' | 'error' | 'stopped'
  asked?: true // the turn ran in an A→B ask chat
  workflow?: true // the turn is an Agent step of a workflow: the run reports for itself
  reply?: string // the turn's reply text, for workflows that start on a reply; may be empty
  cardQuestions?: true // a task chat's agent put questions on its to-do card this turn: they wait in the Inbox
}

export interface RoutineFailure {
  routineId: string
  chatId: string | null
  cause: 'start' | 'turn' | 'user' | 'restart'
}

// Cut so the encrypted body always fits one 4096-byte push record.
const TEXT_MAX = 100

/** Every payload kind; the page reads shown notifications back by it, so one list serves both sides. */
export const NOTIFY_KINDS: readonly NotifyPayloadKind[] = [
  'waiting',
  'replied',
  'error',
  'routine-failed',
  'test',
  'paused',
  'workflow',
  'spend-cap'
]
const KINDS: readonly string[] = NOTIFY_KINDS

const cut = (s: string): string => s.slice(0, TEXT_MAX)

// A routine that opens a new chat per run owns the slot, so a busy schedule shows one entry.
export function slotTag(o: { kind: NotifyPayloadKind; chatId: string | null; routineId: string | null; runId?: string | null }): string {
  if (o.kind === 'test' || o.kind === 'paused') return o.kind
  // A workflow run has no chat; its approvals and its result are separate slots like a chat's.
  const base = o.runId ? `workflow:${o.runId}` : o.routineId ? `routine:${o.routineId}` : o.chatId ? `chat:${o.chatId}` : o.kind
  // Room members run side by side: a reply must never replace a pending approval in the tray.
  return o.kind === 'waiting' ? `${base}:waiting` : base
}

export function buildPayload(o: {
  kind: NotifyPayloadKind
  tag: string
  chatId: string | null
  title: string
  agent?: string
  at: number
  run?: { workflowId: string; runId: string }
  body?: string
  message?: string
  inbox?: true
}): NotifyPayload {
  const p: NotifyPayload = { v: 1, kind: o.kind, tag: o.tag, chatId: o.chatId, title: cut(o.title), at: o.at }
  if (o.agent !== undefined) p.agent = cut(o.agent)
  if (o.run !== undefined) p.run = { workflowId: o.run.workflowId, runId: o.run.runId }
  if (o.body !== undefined) p.body = o.body.slice(0, NOTIFY_BODY_MAX)
  // Only the Notify kind has an Inbox message; any other kind never carries one.
  if (o.message !== undefined && o.kind === 'workflow') p.message = cut(o.message)
  if (o.inbox && o.kind === 'waiting') p.inbox = true
  return p
}

export function notifyText(p: NotifyPayload, agents?: readonly string[]): { title: string; body: string } {
  // The payload keeps handles (merging compares them); only the shown text reads like the UI.
  const handles = agents && agents.length > 0 ? agents : p.agent ? [p.agent] : []
  const names = handles.map(displayName).join(', ')
  const who = names || 'An agent'
  switch (p.kind) {
    case 'waiting':
      return { title: p.title, body: p.inbox ? `${who} has a question for you` : `${who} needs you` }
    case 'replied':
      return { title: p.title, body: `${who} replied` }
    case 'error':
      return { title: p.title, body: `${names ? `${names}'s` : "An agent's"} reply ended with an error` }
    case 'routine-failed':
      // One kind and toggle for both; a workflow's payload carries its run.
      return { title: p.title, body: p.run ? 'Workflow failed' : 'Routine failed' }
    case 'test':
      return { title: p.title || 'ZumiBot', body: 'Notifications work on this device' }
    case 'workflow':
      return { title: p.title, body: p.body ?? '' }
    case 'spend-cap':
      return { title: p.title, body: p.body ?? 'A spend cap paused it' }
    case 'paused':
      return { title: 'ZumiBot', body: 'Signed out. Notifications are paused until you sign in again.' }
  }
}

export function mergeAgents(prev: readonly string[] | undefined, agent: string | undefined): string[] {
  const out = [...(prev ?? [])]
  if (agent && !out.includes(agent)) out.push(agent)
  return out
}

export function isToggles(v: unknown): v is NotifyToggles {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (Object.keys(DEFAULT_TOGGLES) as (keyof NotifyToggles)[]).every((k) => typeof o[k] === 'boolean')
}

function isRun(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const r = v as Record<string, unknown>
  return Object.keys(r).length === 2 && typeof r.workflowId === 'string' && typeof r.runId === 'string'
}

export function isPayload(v: unknown): v is NotifyPayload {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const o = v as Record<string, unknown>
  if (Object.keys(o).some((k) => !PAYLOAD_KEYS.includes(k))) return false
  return (
    o.v === 1 &&
    typeof o.kind === 'string' &&
    KINDS.includes(o.kind) &&
    typeof o.tag === 'string' &&
    (o.chatId === null || typeof o.chatId === 'string') &&
    typeof o.title === 'string' &&
    (o.agent === undefined || typeof o.agent === 'string') &&
    typeof o.at === 'number' &&
    Number.isFinite(o.at) &&
    (o.body === undefined || typeof o.body === 'string') &&
    (o.message === undefined || typeof o.message === 'string') &&
    (o.inbox === undefined || o.inbox === true) &&
    (o.run === undefined || isRun(o.run))
  )
}
