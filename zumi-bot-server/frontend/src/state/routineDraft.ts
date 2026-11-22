import {
  limitPolicyOf,
  missedPolicyOf,
  sessionPolicyOf,
  type LimitPolicy,
  type MissedPolicy,
  type SessionPolicy,
  type Routine,
  type RoutineInput,
  type RoutineTarget,
  type RoutineTrigger,
  type Schedule
} from '@zumibot/shared/routines'
import { routineRefs, spendCapBlocker } from '@zumibot/shared/capAgents'
import { nextRuns, parseCron, parseSchedule } from '@zumibot/shared/schedule'
import { isGroup, type AgentSummary, type ChatMeta } from '@zumibot/shared/types'
import type { CommandPick } from '@zumibot/shared/commands'
import type { SidebarSection } from '@zumibot/shared/sidebarLayout'
import { keepPick } from './commandInput'

export interface RoutineDraft {
  id: string | null
  name: string
  enabled: boolean
  timeZone: string
  triggerKind: 'schedule' | 'manual' | 'webhook'
  schedule: Schedule
  targetKind: 'agent' | 'group'
  agent: string
  groupMembers: string[]
  role: string
  chatChoice: 'new' | string // 'new' or an existing chat id
  cwd: string
  chatTitle: string // a new chat's or room's title; '' = the routine's name and the date
  section: string // a new room's sidebar section id; '' = outside every section
  prompt: string
  command: CommandPick | null // the `/` menu's pick for the prompt's leading `/name`
  condition: string // webhook only: Jev checks each call against it; '' = every call runs
  limitPolicy: LimitPolicy
  missedPolicy: MissedPolicy // kept off schedule too, so switching back keeps the choice
  sessionPolicy: SessionPolicy // shown for an existing chat only; kept for a new one, like missedPolicy
  spendCap: number | null // USD one run may spend; null = no cap
}

export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]
export type Freq = Schedule['freq']
export const FREQS: { value: Freq; label: string }[] = [
  { value: 'once', label: 'Once' },
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
  { value: 'custom', label: 'Custom' }
]

export function emptyDraft(timeZone: string): RoutineDraft {
  return {
    id: null,
    name: '',
    enabled: true,
    timeZone,
    triggerKind: 'schedule',
    schedule: { freq: 'daily', time: '09:00', days: [...ALL_DAYS] },
    targetKind: 'agent',
    agent: '',
    groupMembers: [],
    role: '',
    chatChoice: 'new',
    cwd: '',
    chatTitle: '',
    section: '',
    prompt: '',
    command: null,
    condition: '',
    limitPolicy: limitPolicyOf(null),
    missedPolicy: missedPolicyOf(null),
    sessionPolicy: sessionPolicyOf(null),
    spendCap: null
  }
}

/** `chats` tells an existing-chat target apart: a group chat shows as Group, a single chat keeps its agent. */
export function draftFromRoutine(r: Routine, chats: readonly ChatMeta[] = []): RoutineDraft {
  const d = emptyDraft(r.timeZone)
  d.id = r.id
  d.name = r.name
  d.enabled = r.enabled
  d.prompt = r.prompt
  d.command = r.command ?? null
  d.limitPolicy = limitPolicyOf(r)
  d.missedPolicy = missedPolicyOf(r)
  d.sessionPolicy = sessionPolicyOf(r)
  d.spendCap = r.spendCap ?? null
  d.triggerKind = r.trigger.kind
  if (r.trigger.kind === 'schedule') d.schedule = structuredClone(r.trigger.schedule)
  if (r.trigger.kind === 'webhook') d.condition = r.trigger.condition ?? ''
  const t = r.target
  if (t.kind === 'new-chat') Object.assign(d, { agent: t.agent, cwd: t.cwd, chatTitle: t.title ?? '' })
  else if (t.kind === 'new-group')
    Object.assign(d, {
      targetKind: 'group',
      groupMembers: [...t.members],
      role: t.role,
      cwd: t.cwd,
      chatTitle: t.title ?? '',
      section: t.section ?? ''
    })
  else {
    d.chatChoice = t.chatId
    const chat = chats.find((c) => c.id === t.chatId)
    if (chat && isGroup(chat)) d.targetKind = 'group'
    else if (chat) d.agent = chat.agentName
  }
  return d
}

export function draftToInput(d: RoutineDraft): RoutineInput {
  const condition = d.condition.trim()
  const trigger: RoutineTrigger =
    d.triggerKind === 'schedule'
      ? { kind: 'schedule', schedule: d.schedule }
      : d.triggerKind === 'manual'
        ? { kind: 'manual' }
        : { kind: 'webhook', sample: null, ...(condition ? { condition } : {}) } // the server fills the sample from the test call
  const title = d.chatTitle.trim()
  const named = title ? { title } : {}
  let target: RoutineTarget
  if (d.chatChoice !== 'new') target = { kind: 'chat', chatId: d.chatChoice }
  else if (d.targetKind === 'group')
    target = {
      kind: 'new-group',
      members: d.groupMembers,
      role: d.role,
      cwd: d.cwd,
      ...named,
      ...(d.section ? { section: d.section } : {})
    }
  else target = { kind: 'new-chat', agent: d.agent, cwd: d.cwd, ...named }
  return {
    id: d.id,
    name: d.name,
    enabled: d.enabled,
    timeZone: d.timeZone,
    trigger,
    target,
    prompt: d.prompt,
    command: keepPick(d.prompt, d.command),
    limitPolicy: d.limitPolicy,
    missedPolicy: d.missedPolicy,
    sessionPolicy: d.sessionPolicy,
    ...(d.spendCap !== null ? { spendCap: d.spendCap } : {})
  }
}

/** Whose commands the prompt's `/` menu lists, and whether it lists them under each agent (a room). */
export function promptCommandAgents(
  d: Pick<RoutineDraft, 'targetKind' | 'agent' | 'groupMembers' | 'chatChoice'>,
  agents: readonly AgentSummary[],
  chats: readonly ChatMeta[]
): { agents: AgentSummary[]; grouped: boolean } {
  const named = (names: readonly string[]): AgentSummary[] => names.flatMap((n) => agents.filter((a) => a.name === n))
  if (d.targetKind === 'agent') return { agents: named(d.agent ? [d.agent] : []), grouped: false }
  if (d.chatChoice === 'new') return { agents: named(d.groupMembers), grouped: true }
  const chat = chats.find((c) => c.id === d.chatChoice)
  return { agents: chat && isGroup(chat) ? named(chat.group.members) : [], grouped: true }
}

/** The section the picker shows: one deleted since reads as outside every section, where the run then leaves the room. */
export const shownSection = (section: string, sections: readonly Pick<SidebarSection, 'id'>[]): string =>
  sections.some((s) => s.id === section) ? section : ''

export function draftErrors(d: RoutineDraft, hasTestCall: boolean): string[] {
  const e: string[] = []
  if (!d.name.trim()) e.push('Name is required')
  if (!d.prompt.trim()) e.push('Prompt is required')
  const existingChat = d.chatChoice !== 'new'
  if (d.targetKind === 'agent' && !existingChat && !d.agent) e.push('Pick an agent')
  if (d.targetKind === 'group' && !existingChat && d.groupMembers.length < 2) e.push('Pick at least 2 members')
  if (!existingChat && !d.cwd.trim()) e.push('Choose a folder')
  if (d.triggerKind === 'schedule' && d.schedule.freq === 'custom' && parseSchedule(d.schedule) === null) e.push('Invalid cron expression')
  if (d.triggerKind === 'webhook' && !hasTestCall) e.push('Webhook needs a test call before saving')
  return e
}

export const isDraftDirty = (a: RoutineDraft, saved: RoutineDraft): boolean => JSON.stringify(a) !== JSON.stringify(saved)

/** Three next times as "Tue, Oct 27, 7:00 AM" in the zone, or null for an invalid expression. */
export function cronPreview(cron: string, timeZone: string, now: number): string[] | null {
  if (parseCron(cron) === null) return null
  const times = nextRuns({ freq: 'custom', cron }, timeZone, now, 3)
  if (times.length === 0) return null
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
  return times.map((t) => f.format(t))
}

/** The schedule for a newly picked frequency, keeping the time (and days) the user already chose. */
export function scheduleForFreq(freq: Freq, prev: Schedule, today: string): Schedule {
  const time = 'time' in prev ? prev.time : '09:00'
  const days = 'days' in prev ? prev.days : ALL_DAYS
  switch (freq) {
    case 'once':
      return { freq, date: prev.freq === 'once' ? prev.date : today, time }
    case 'hourly':
      return { freq, minute: prev.freq === 'hourly' ? prev.minute : 0, days: [...days] }
    case 'daily':
      return { freq, time, days: [...days] }
    case 'weekly':
      return { freq, day: prev.freq === 'weekly' ? prev.day : 1, time }
    case 'monthly':
      return { freq, day: prev.freq === 'monthly' ? prev.day : 1, time }
    case 'yearly':
      return { freq, month: prev.freq === 'yearly' ? prev.month : 1, day: prev.freq === 'yearly' ? prev.day : 1, time }
    case 'custom':
      return { freq, cron: prev.freq === 'custom' ? prev.cron : '0 9 * * *' }
  }
}

export interface Clock12 {
  hour: number
  minute: number
  pm: boolean
}
export function toClock12(time: string): Clock12 {
  const [h, m] = time.split(':').map(Number)
  return { hour: h % 12 || 12, minute: m, pm: h >= 12 }
}
export function fromClock12(c: Clock12): string {
  const h = (c.hour % 12) + (c.pm ? 12 : 0)
  return `${String(h).padStart(2, '0')}:${String(c.minute).padStart(2, '0')}`
}
/** `9 AM`, or `9:30 AM` when there are minutes. */
export function timePillLabel(time: string): string {
  const c = toClock12(time)
  return `${c.hour}${c.minute ? ':' + String(c.minute).padStart(2, '0') : ''} ${c.pm ? 'PM' : 'AM'}`
}
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export function daysPillLabel(days: number[]): string {
  const s = [...days].sort((a, b) => a - b).join(',')
  if (s === ALL_DAYS.join(',')) return 'Every day'
  if (s === '1,2,3,4,5') return 'Weekdays'
  if (s === '0,6') return 'Weekends'
  return [...days]
    .sort((a, b) => a - b)
    .map((d) => DAY_NAMES[d])
    .join(', ')
}

/**
 * Why the spend cap can't be set: an agent the routine runs is on an engine without `cost` (the fixed sentence naming it), else
 * null. The editor shows this in the cap's place; the server refuses such a cap at save and again where a run starts.
 */
export function routineCapBlocker(d: RoutineDraft, agents: readonly AgentSummary[], chats: readonly ChatMeta[]): string | null {
  return spendCapBlocker(routineRefs(draftToInput(d).target), agents, (id) => chats.find((c) => c.id === id))
}
