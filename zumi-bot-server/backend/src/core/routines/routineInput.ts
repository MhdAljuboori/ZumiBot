import { parseSpendCap } from '@zumibot/shared/spendCaps'
import { GROUP_MIN_MEMBERS, ROLE_MAX_CHARS } from '@zumibot/shared/types'
import { JEV_CONDITION_MAX } from '@zumibot/shared/jev'
import { leadingCommand, type CommandPick } from '@zumibot/shared/commands'
import {
  ROUTINE_CHAT_TITLE_MAX,
  ROUTINE_NAME_MAX,
  ROUTINE_PROMPT_MAX,
  type LimitPolicy,
  type MissedPolicy,
  type SessionPolicy,
  type RoutineInput,
  type RoutineTarget,
  type RoutineTrigger
} from '@zumibot/shared/routines'
import { isTimeZone, parseSchedule } from '@zumibot/shared/schedule'
import { SECTION_ID_MAX } from '@zumibot/shared/sidebarLayout'
import { groupRole, memberList, refuseZumiBot } from '../groupMembers'

function object(v: unknown, field: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new TypeError(`${field} must be an object`)
  return v as Record<string, unknown>
}
function string(v: unknown, field: string, nonempty = false): string {
  if (typeof v !== 'string' || (nonempty && v.length === 0))
    throw new TypeError(`${field} must be ${nonempty ? 'a non-empty string' : 'a string'}`)
  return v
}
// Absent: a page loaded before the policies existed, so the routine keeps the defaults.
function choice<T extends string>(v: unknown, field: string, values: readonly T[]): T {
  if (v === undefined) return values[0]!
  if (typeof v !== 'string' || !values.includes(v as T)) throw new TypeError(`${field} must be one of ${values.join(', ')}`)
  return v as T
}
// Absent or null: no pick (also a page from before routines took commands). A pick for another name than the prompt's
// leading one is stale, and dropped as the composer drops it.
function commandPick(v: unknown, prompt: string): CommandPick | null {
  if (v === undefined || v === null) return null
  const o = object(v, 'command')
  const agent = string(o.agent, 'command.agent', true)
  const name = string(o.name, 'command.name', true)
  return leadingCommand(prompt)?.name === name ? { agent, name } : null
}
// Absent, null or blank: none, so a routine saved before these keys (or with the field left empty) stores neither.
function chatTitle(v: unknown): { title?: string } {
  if (v === undefined || v === null) return {}
  const title = string(v, 'title').trim()
  if (title.length > ROUTINE_CHAT_TITLE_MAX) throw new TypeError(`title must be at most ${ROUTINE_CHAT_TITLE_MAX} characters`)
  return title ? { title } : {}
}
// A section id only: one deleted since is left for the run to skip, as the sidebar may change any time after the save.
function sectionId(v: unknown): { section?: string } {
  if (v === undefined || v === null || v === '') return {}
  const section = string(v, 'section')
  if (section.length > SECTION_ID_MAX) throw new TypeError('section is invalid')
  return { section }
}
export function parseRoutineInput(v: unknown): RoutineInput {
  const x = object(v, 'input')
  const id = x.id
  if (id !== null && (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(id)))
    throw new TypeError('id must be null or a valid routine id')
  const name = string(x.name, 'name', true)
  if (name.length > ROUTINE_NAME_MAX) throw new TypeError('name is too long')
  if (typeof x.enabled !== 'boolean') throw new TypeError('enabled must be a boolean')
  const timeZone = string(x.timeZone, 'timeZone', true)
  if (!isTimeZone(timeZone)) throw new TypeError('timeZone is invalid')
  const prompt = string(x.prompt, 'prompt', true)
  if (prompt.length > ROUTINE_PROMPT_MAX) throw new TypeError('prompt is too long')

  const rawTrigger = object(x.trigger, 'trigger')
  let trigger: RoutineTrigger
  if (rawTrigger.kind === 'manual') trigger = { kind: 'manual' }
  else if (rawTrigger.kind === 'webhook') {
    const raw = rawTrigger.condition
    if (raw !== undefined && raw !== null && typeof raw !== 'string') throw new TypeError('condition must be a string')
    const condition = (raw ?? '').trim()
    if (condition.length > JEV_CONDITION_MAX) throw new TypeError('condition is too long')
    trigger = condition ? { kind: 'webhook', sample: null, condition } : { kind: 'webhook', sample: null }
  } else if (rawTrigger.kind === 'schedule') {
    const schedule = parseSchedule(rawTrigger.schedule)
    if (!schedule) throw new TypeError('schedule is invalid')
    trigger = { kind: 'schedule', schedule }
  } else throw new TypeError('trigger is invalid')

  const rawTarget = object(x.target, 'target')
  let target: RoutineTarget
  if (rawTarget.kind === 'new-chat') {
    target = {
      kind: 'new-chat',
      agent: string(rawTarget.agent, 'agent', true),
      cwd: string(rawTarget.cwd, 'cwd', true),
      ...chatTitle(rawTarget.title)
    }
  } else if (rawTarget.kind === 'new-group') {
    let members: string[]
    try {
      members = memberList(rawTarget.members)
    } catch {
      throw new TypeError('members is invalid')
    }
    if (members.length < GROUP_MIN_MEMBERS || members.some((m) => m.length === 0))
      throw new TypeError('members must contain at least two non-empty agent names')
    refuseZumiBot(members) // the rule chats:createGroup applies
    let role: string
    try {
      role = groupRole(rawTarget.role)
    } catch {
      throw new TypeError(`role must be a string of at most ${ROLE_MAX_CHARS} characters`)
    }
    target = {
      kind: 'new-group',
      members,
      role,
      cwd: string(rawTarget.cwd, 'cwd', true),
      ...chatTitle(rawTarget.title),
      ...sectionId(rawTarget.section)
    }
  } else if (rawTarget.kind === 'chat') target = { kind: 'chat', chatId: string(rawTarget.chatId, 'chatId', true) }
  else throw new TypeError('target is invalid')

  const limitPolicy = choice<LimitPolicy>(x.limitPolicy, 'limitPolicy', ['wait', 'skip'])
  const missedPolicy = choice<MissedPolicy>(x.missedPolicy, 'missedPolicy', ['run-once', 'skip'])
  const sessionPolicy = choice<SessionPolicy>(x.sessionPolicy, 'sessionPolicy', ['continue', 'fresh'])
  const command = commandPick(x.command, prompt)
  // Absent or null: no cap. Anything else must be an amount the editor could have sent.
  const spendCap = x.spendCap === undefined || x.spendCap === null ? null : parseSpendCap(x.spendCap)
  if (spendCap === null && x.spendCap !== undefined && x.spendCap !== null) throw new TypeError('spendCap is invalid')
  return {
    id: id as string | null,
    name,
    enabled: x.enabled,
    timeZone,
    trigger,
    target,
    prompt,
    limitPolicy,
    missedPolicy,
    sessionPolicy,
    command,
    ...(spendCap !== null ? { spendCap } : {})
  }
}
