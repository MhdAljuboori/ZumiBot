import { describe, expect, it } from 'vitest'
import { ROUTINE_CHAT_TITLE_MAX, ROUTINE_NAME_MAX, ROUTINE_PROMPT_MAX, type RoutineInput } from '@zumibot/shared/routines'
import { ROLE_MAX_CHARS } from '@zumibot/shared/types'
import { JEV_CONDITION_MAX } from '@zumibot/shared/jev'
import { parseRoutineInput } from '../../src/core/routines/routineInput'

const valid = (): Record<string, unknown> => ({
  id: null,
  name: 'Routine',
  enabled: true,
  timeZone: 'UTC',
  trigger: { kind: 'manual' },
  target: { kind: 'new-chat', agent: 'Agent', cwd: '/tmp' },
  prompt: 'hello'
})
function rejects(field: string, patch: Record<string, unknown>) {
  expect(() => parseRoutineInput({ ...valid(), ...patch })).toThrow(new RegExp(field))
}

describe('parseRoutineInput', () => {
  it('accepts a valid input', () => {
    expect(parseRoutineInput(valid())).toMatchObject({ name: 'Routine', id: null })
  })
  it('validates name and prompt bounds', () => {
    rejects('name', { name: '' })
    rejects('name', { name: 'x'.repeat(ROUTINE_NAME_MAX + 1) })
    rejects('prompt', { prompt: '' })
    rejects('prompt', { prompt: 'x'.repeat(ROUTINE_PROMPT_MAX + 1) })
  })
  it('validates time zone and schedule', () => {
    rejects('timeZone', { timeZone: 'Mars/Base' })
    rejects('schedule', { trigger: { kind: 'schedule', schedule: { freq: 'daily', time: '99:99', days: [] } } })
  })
  it('validates group members and role length', () => {
    rejects('members', { target: { kind: 'new-group', members: ['only'], role: '', cwd: '/tmp' } })
    rejects('role', { target: { kind: 'new-group', members: ['A', 'B'], role: 'x'.repeat(ROLE_MAX_CHARS + 1), cwd: '/tmp' } })
    rejects("Zumi Bot can't join", { target: { kind: 'new-group', members: ['A', 'zumi-bot'], role: '', cwd: '/tmp' } })
  })
  it('keeps a trimmed chat title and a room section, dropping blank ones', () => {
    const group = { kind: 'new-group', members: ['A', 'B'], role: '', cwd: '/tmp' }
    expect(
      parseRoutineInput({ ...valid(), target: { kind: 'new-chat', agent: 'A', cwd: '/tmp', title: '  Morning brief ' } }).target
    ).toEqual({ kind: 'new-chat', agent: 'A', cwd: '/tmp', title: 'Morning brief' })
    expect(parseRoutineInput({ ...valid(), target: { ...group, title: 'Standup', section: 'sec-1' } }).target).toEqual({
      ...group,
      title: 'Standup',
      section: 'sec-1'
    })
    // Blank, null or absent: stored as neither key, as a routine saved before them.
    expect(parseRoutineInput({ ...valid(), target: { ...group, title: '   ', section: '' } }).target).toEqual(group)
    expect(parseRoutineInput({ ...valid(), target: { ...group, title: null, section: null } }).target).toEqual(group)
    // A section names a room's place only: a new single chat keeps none.
    expect(parseRoutineInput({ ...valid(), target: { kind: 'new-chat', agent: 'A', cwd: '/tmp', section: 'sec-1' } }).target).toEqual({
      kind: 'new-chat',
      agent: 'A',
      cwd: '/tmp'
    })
    rejects('title', { target: { kind: 'new-chat', agent: 'A', cwd: '/tmp', title: 'x'.repeat(ROUTINE_CHAT_TITLE_MAX + 1) } })
    rejects('title', { target: { kind: 'new-chat', agent: 'A', cwd: '/tmp', title: 3 } })
    rejects('section', { target: { ...group, section: 'x'.repeat(65) } })
    rejects('section', { target: { ...group, section: 7 } })
  })
  it('validates cwd type and ignores webhook sample', () => {
    rejects('cwd', { target: { kind: 'new-chat', agent: 'A', cwd: 3 } })
    const input = parseRoutineInput({
      ...valid(),
      trigger: { kind: 'webhook', sample: { method: 'POST', secret: 'ignore' } }
    }) as RoutineInput
    expect(input.trigger).toEqual({ kind: 'webhook', sample: null })
  })
  it('keeps a trimmed webhook condition and drops a blank one', () => {
    const parse = (condition: unknown) =>
      (parseRoutineInput({ ...valid(), trigger: { kind: 'webhook', sample: null, condition } }) as RoutineInput).trigger
    expect(parse('  the build failed ')).toEqual({ kind: 'webhook', sample: null, condition: 'the build failed' })
    expect(parse('   ')).toEqual({ kind: 'webhook', sample: null })
    expect(parse(undefined)).toEqual({ kind: 'webhook', sample: null })
    rejects('condition', { trigger: { kind: 'webhook', sample: null, condition: 3 } })
    rejects('condition', { trigger: { kind: 'webhook', sample: null, condition: 'x'.repeat(JEV_CONDITION_MAX + 1) } })
  })
  it('keeps the limit and missed policies, defaulting them for a client that sends none', () => {
    expect(parseRoutineInput({ ...valid(), limitPolicy: 'skip', missedPolicy: 'skip' })).toMatchObject({
      limitPolicy: 'skip',
      missedPolicy: 'skip'
    })
    expect(parseRoutineInput(valid())).toMatchObject({ limitPolicy: 'wait', missedPolicy: 'run-once' })
    rejects('limitPolicy', { limitPolicy: 'retry' })
    rejects('missedPolicy', { missedPolicy: true })
  })
  it('keeps the session policy, continuing by default', () => {
    expect(parseRoutineInput({ ...valid(), sessionPolicy: 'fresh' })).toMatchObject({ sessionPolicy: 'fresh' })
    expect(parseRoutineInput(valid())).toMatchObject({ sessionPolicy: 'continue' })
    rejects('sessionPolicy', { sessionPolicy: 'new' })
  })
  it("keeps a command pick only for the prompt's leading name", () => {
    const command = { agent: 'wk', name: 'check' }
    expect(parseRoutineInput({ ...valid(), prompt: '/check today', command }).command).toEqual(command)
    expect(parseRoutineInput({ ...valid(), prompt: '/check today', command: null }).command).toBeNull()
    expect(parseRoutineInput({ ...valid(), prompt: '/check today' }).command).toBeNull()
    expect(parseRoutineInput({ ...valid(), prompt: '/fix today', command }).command).toBeNull()
    expect(parseRoutineInput({ ...valid(), prompt: 'check today', command }).command).toBeNull()
    rejects('command', { prompt: '/check', command: 'check' })
    rejects('command.agent', { prompt: '/check', command: { name: 'check' } })
    rejects('command.name', { prompt: '/check', command: { agent: 'wk', name: 3 } })
  })
})

describe('a routine run spend cap', () => {
  it('keeps an amount and leaves no key for none or null', () => {
    expect(parseRoutineInput({ ...valid(), spendCap: 3.5 })).toMatchObject({ spendCap: 3.5 })
    expect(parseRoutineInput(valid())).not.toHaveProperty('spendCap')
    expect(parseRoutineInput({ ...valid(), spendCap: null })).not.toHaveProperty('spendCap')
  })
  it('refuses an amount the editor could not have sent', () => {
    for (const bad of [0, 'x', 20_000]) expect(() => parseRoutineInput({ ...valid(), spendCap: bad })).toThrow('spendCap is invalid')
  })
})
