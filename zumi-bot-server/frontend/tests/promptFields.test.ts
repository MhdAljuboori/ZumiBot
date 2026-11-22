import { describe, expect, it } from 'vitest'
import type { RoutineRun } from '@zumibot/shared/routines'
import {
  caretMenuPlace,
  conditionLabel,
  docToPrompt,
  joinPrompt,
  missingLabel,
  pauseLabel,
  policyLabel,
  promptToDoc,
  runLabel,
  splitPrompt,
  viaLabel
} from '../src/state/promptFields'

describe('splitPrompt / joinPrompt', () => {
  it.each(['Review {{body.pr.title}} now', '{{a}}{{b}}', '', 'no fields'])('round-trips %j', (s) => {
    expect(joinPrompt(splitPrompt(s))).toBe(s)
  })
  it('reads a spaced placeholder as a field', () => {
    expect(splitPrompt('{{ body.x }}')).toEqual([{ type: 'field', path: 'body.x' }])
  })
  it('keeps text around fields in order', () => {
    expect(splitPrompt('a {{x}} b')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'field', path: 'x' },
      { type: 'text', text: ' b' }
    ])
  })
  it('is stable across repeated calls (global regex state)', () => {
    expect(splitPrompt('{{a}}')).toEqual(splitPrompt('{{a}}'))
  })
})

describe('promptToDoc / docToPrompt', () => {
  it.each(['one line', 'a {{x}}\nb\n\n{{y}} c', '', '\n'])('round-trips %j', (s) => {
    expect(docToPrompt(promptToDoc(s))).toBe(s)
  })
  it('makes a chip node per field', () => {
    const doc = promptToDoc('hi {{body.a}}')
    expect(doc.content?.[0].content).toEqual([
      { type: 'text', text: 'hi ' },
      { type: 'fieldChip', attrs: { path: 'body.a' } }
    ])
  })
})

describe('plain mode', () => {
  it('keeps {{x}} as text when chips are off', () => {
    const doc = promptToDoc('a {{x}}', false)
    expect(doc.content?.[0].content).toEqual([{ type: 'text', text: 'a {{x}}' }])
    expect(docToPrompt(doc)).toBe('a {{x}}')
  })
})

describe('runLabel', () => {
  const run = (startedAt: number): RoutineRun => ({
    id: 'r',
    routineId: 'x',
    via: 'manual',
    status: 'done',
    late: false,
    chatId: null,
    messageId: null,
    startedAt
  })
  const now = Date.UTC(2026, 9, 27, 12, 0)
  it('says Today and Yesterday in the zone', () => {
    expect(runLabel(run(Date.UTC(2026, 9, 27, 7, 0)), now, 'UTC')).toBe('Today 07:00')
    expect(runLabel(run(Date.UTC(2026, 9, 26, 7, 0)), now, 'UTC')).toBe('Yesterday 07:00')
  })
  it('says the date for older runs', () => {
    expect(runLabel(run(Date.UTC(2026, 9, 25, 7, 0)), now, 'UTC')).toBe('Oct 25 07:00')
  })
  it('uses the routine time zone for the day', () => {
    // 23:30 UTC on the 26th is already the 27th in Tokyo.
    expect(runLabel(run(Date.UTC(2026, 9, 26, 23, 30)), now, 'Asia/Tokyo')).toBe('Today 08:30')
  })
})

describe('policyLabel', () => {
  const run = (o: Partial<RoutineRun> = {}): RoutineRun => ({
    id: 'r',
    routineId: 'x',
    via: 'schedule',
    status: 'done',
    late: false,
    chatId: null,
    messageId: null,
    startedAt: 1,
    ...o
  })
  const now = Date.UTC(2026, 9, 27, 12, 0)
  it('says when a run waiting for the usage limit continues, in the zone', () => {
    expect(policyLabel(run({ status: 'limited', resumeAt: Date.UTC(2026, 9, 27, 14, 41) }), now, 'UTC')).toBe(
      'Usage limit reached · continues today at 14:41'
    )
    expect(policyLabel(run({ status: 'limited', resumeAt: Date.UTC(2026, 9, 28, 2, 0) }), now, 'UTC')).toBe(
      'Usage limit reached · continues tomorrow at 02:00'
    )
    expect(policyLabel(run({ status: 'limited', resumeAt: Date.UTC(2026, 9, 30, 9, 5) }), now, 'Asia/Baghdad')).toBe(
      'Usage limit reached · continues Oct 30 at 12:05'
    )
  })
  it('says why a run was skipped', () => {
    expect(policyLabel(run({ status: 'skipped', skipReason: 'missed', late: true }), now, 'UTC')).toBe(
      'Skipped: ZumiBot was off when it was due'
    )
    expect(policyLabel(run({ status: 'skipped', skipReason: 'limit' }), now, 'UTC')).toBe('Skipped: the usage limit was reached')
  })
  it('notes a run that went on after a reset, and is null otherwise', () => {
    expect(policyLabel(run({ waits: 2 }), now, 'UTC')).toBe('Continued after 2 usage limit resets')
    expect(policyLabel(run({ status: 'running', waits: 1 }), now, 'UTC')).toBe('Continued after a usage limit reset')
    expect(policyLabel(run(), now, 'UTC')).toBeNull()
    expect(policyLabel(run({ status: 'skipped' }), now, 'UTC')).toBeNull() // a webhook condition: conditionLabel says it
  })
})

describe('pauseLabel', () => {
  const run = (o: Partial<RoutineRun> = {}): RoutineRun => ({
    id: 'r',
    routineId: 'x',
    via: 'schedule',
    status: 'done',
    late: false,
    chatId: null,
    messageId: null,
    startedAt: 1,
    ...o
  })
  it('says how to go on with a paused run', () => {
    expect(pauseLabel(run({ status: 'paused' }))).toBe('Paused by you · press Resume in its chat to continue')
    expect(pauseLabel(run({ status: 'paused', resumes: 1 }))).toBe('Paused by you · press Resume in its chat to continue')
  })
  it('notes a run that went on after a Resume, and is null otherwise', () => {
    expect(pauseLabel(run({ resumes: 1 }))).toBe('Resumed after a pause')
    expect(pauseLabel(run({ status: 'running', resumes: 3 }))).toBe('Resumed after 3 pauses')
    expect(pauseLabel(run())).toBeNull()
  })
})

describe('viaLabel', () => {
  const run = (via: RoutineRun['via']): RoutineRun => ({
    id: 'r',
    routineId: 'x',
    via,
    status: 'done',
    late: false,
    chatId: null,
    messageId: null,
    startedAt: 1
  })
  it('tags a Run now run as manual', () => {
    expect(viaLabel(run('manual'))).toBe('manual')
  })
  it('is null for runs the trigger started', () => {
    expect(viaLabel(run('schedule'))).toBeNull()
    expect(viaLabel(run('webhook'))).toBeNull()
  })
})

describe('missingLabel', () => {
  const run = (missingFields?: string[]): RoutineRun => ({
    id: 'r',
    routineId: 'x',
    via: 'webhook',
    status: 'done',
    late: false,
    chatId: null,
    messageId: null,
    startedAt: 1,
    ...(missingFields ? { missingFields } : {})
  })
  it('names the fields the call lacked, as the prompt writes them', () => {
    expect(missingLabel(run(['body.title', 'body.author']))).toBe('Missing: body.title, body.author')
  })
  it('is null when nothing was missing', () => {
    expect(missingLabel(run())).toBeNull()
    expect(missingLabel(run([]))).toBeNull()
  })
})

describe('conditionLabel', () => {
  const run = (o: Partial<RoutineRun> = {}): RoutineRun => ({
    id: 'r',
    routineId: 'x',
    via: 'webhook',
    status: 'done',
    late: false,
    chatId: null,
    messageId: null,
    startedAt: 1,
    ...o
  })
  it('says what Jev found, with its odds', () => {
    expect(conditionLabel(run({ status: 'skipped', condition: { met: false, p: 0.123 } }))).toBe(
      'Condition not met (Jev: 12% likely), so no chat was made'
    )
    expect(conditionLabel(run({ condition: { met: true, p: 0.876 } }))).toBe('Condition met (Jev: 88% likely)')
    expect(conditionLabel(run({ condition: { met: null } }))).toBe('Condition not checked: Jev did not answer, so the run went ahead')
  })
  it('is null for a run with no check', () => {
    expect(conditionLabel(run())).toBeNull()
  })
})

describe('caretMenuPlace', () => {
  const box = { left: 100, top: 50, bottom: 650, width: 600 }
  it('opens under the caret line when the viewport has room', () => {
    expect(caretMenuPlace({ left: 180, top: 100, bottom: 120 }, box, 900)).toEqual({ left: 80, top: 74 })
  })
  it('opens over the caret line near the viewport bottom', () => {
    expect(caretMenuPlace({ left: 180, top: 600, bottom: 620 }, box, 700)).toEqual({ left: 80, bottom: 54 })
  })
  it('stays under when there is even less room above', () => {
    expect(caretMenuPlace({ left: 180, top: 100, bottom: 120 }, box, 300)).toEqual({ left: 80, top: 74 })
  })
  it('keeps the menu inside the field on the right and the left', () => {
    expect(caretMenuPlace({ left: 690, top: 100, bottom: 120 }, box, 900).left).toBe(360)
    expect(caretMenuPlace({ left: 50, top: 100, bottom: 120 }, box, 900).left).toBe(0)
    expect(caretMenuPlace({ left: 150, top: 100, bottom: 120 }, { ...box, width: 200 }, 900).left).toBe(0)
  })
})
