import { describe, expect, it } from 'vitest'
import type { ChatItem, GroupInfo, QueuedTask } from '@zumibot/shared/types'
import type { PendingSend } from '../src/state/pendingSends'
import { TRAYS_KEY, focusAfterRemoval, sendsAsTask, taskLabel, taskName, tasksHeld } from '../src/state/tasks'

const task = (extra: Partial<QueuedTask> = {}): QueuedTask => ({ id: 't', text: 'x', ts: 1, ...extra })
const pend = (error: string | null): PendingSend => ({ item: { type: 'user', id: 'p', text: 'hi', ts: 1 }, error })
const paused: ChatItem[] = [{ type: 'notice', id: 'n', kind: 'paused', text: 'paused', ts: 1 }]
const group: GroupInfo = { members: [], sessions: {}, seen: {}, role: '', active: [], queue: [] }

describe('sendsAsTask', () => {
  it('is false for an idle chat with no tasks and nothing pending', () => {
    expect(sendsAsTask({ inFlight: false }, [], [])).toBe(false)
  })
  it('is true while the chat runs', () => {
    expect(sendsAsTask({ inFlight: true }, [], [])).toBe(true)
  })
  it('is true when a plain chat holds tasks', () => {
    expect(sendsAsTask({ inFlight: false, tasks: [task()] }, [], [])).toBe(true)
  })
  it('is false when a paused group holds tasks: a written message goes straight out', () => {
    expect(sendsAsTask({ inFlight: false, tasks: [task()], group }, paused, [])).toBe(false)
  })
  it('is true when a group holds tasks but is not paused', () => {
    expect(sendsAsTask({ inFlight: false, tasks: [task()], group }, [], [])).toBe(true)
  })
  it('a held idle chat sends a written message straight away', () => {
    expect(sendsAsTask({ inFlight: false, tasks: [task()], held: true }, [], [])).toBe(false)
  })
  it('is still true while a held chat runs', () => {
    expect(sendsAsTask({ inFlight: true, tasks: [task()], held: true }, [], [])).toBe(true)
  })
  it('a paused idle chat with held tasks sends a written message straight away', () => {
    expect(sendsAsTask({ inFlight: false, tasks: [task()], pause: 'paused' }, [], [])).toBe(false)
    expect(sendsAsTask({ inFlight: false, tasks: [task()], held: true, pause: 'paused' }, [], [])).toBe(false)
  })
  it('an idle chat waiting out a usage limit sends a written message straight away', () => {
    const resume = { at: 9000, after: 'u1', waits: 1 }
    expect(sendsAsTask({ inFlight: false, tasks: [task()], resume }, [], [])).toBe(false)
    expect(sendsAsTask({ inFlight: true, tasks: [task()], resume }, [], [])).toBe(true)
  })
  it('a pausing chat still runs, so a written message queues', () => {
    expect(sendsAsTask({ inFlight: true, tasks: [task()], held: true, pause: 'pausing' }, [], [])).toBe(true)
  })
  it('is true while a send is on its way', () => {
    expect(sendsAsTask({ inFlight: false }, [], [pend(null)])).toBe(true)
  })
  it('is false when the only pending send failed', () => {
    expect(sendsAsTask({ inFlight: false }, [], [pend('boom')])).toBe(false)
  })
})

describe('taskLabel', () => {
  it('collapses whitespace and trims', () => {
    expect(taskLabel(task({ text: ' a\n\n  b ' }))).toBe('a b')
  })
  it('falls back to the first attachment name for blank text', () => {
    const attachments = [{ id: 'a', name: 'x.png', mime: 'image/png', size: 1, kind: 'image' as const }]
    expect(taskLabel(task({ text: '', attachments }))).toBe('x.png')
  })
})

describe('TRAYS_KEY', () => {
  it('is the storage key', () => expect(TRAYS_KEY).toBe('zumibot.collapsedTrays'))
})

describe('tasksHeld', () => {
  it('is true for an idle paused chat: Send now ends the pause', () => {
    expect(tasksHeld({ inFlight: false, pause: 'paused' }, [])).toBe(true)
    expect(tasksHeld({ inFlight: true, pause: 'pausing' }, [])).toBe(false)
  })
  it('is true for an idle group paused at its end', () => {
    expect(tasksHeld({ inFlight: false, group }, paused)).toBe(true)
  })
  it('tasks a usage limit wait holds offer Send now', () => {
    const resume = { at: 9000, after: 'u1', waits: 1 }
    expect(tasksHeld({ inFlight: false, resume }, [])).toBe(true)
    expect(tasksHeld({ inFlight: true, resume }, [])).toBe(false)
  })
  it('held tasks offer Send now in a single chat', () => {
    expect(tasksHeld({ inFlight: false, held: true }, [])).toBe(true)
    expect(tasksHeld({ inFlight: true, held: true }, [])).toBe(false)
  })
  it('is false while the room runs, for a group not paused, and for a single chat', () => {
    expect(tasksHeld({ inFlight: true, group }, paused)).toBe(false)
    expect(tasksHeld({ inFlight: false, group }, [])).toBe(false)
    expect(tasksHeld({ inFlight: false }, paused)).toBe(false)
  })
})

describe('taskName', () => {
  it('is the label when short', () => {
    expect(taskName(task({ text: 'fix  the\nbug' }))).toBe('fix the bug')
  })
  it('cuts a long label with an ellipsis', () => {
    expect(taskName(task({ text: 'x'.repeat(100) }), 10)).toBe(`${'x'.repeat(10)}…`)
  })
})

describe('focusAfterRemoval', () => {
  const list = [task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c' })]
  it('waits while the row is still listed', () => {
    expect(focusAfterRemoval(list, 'b', 'c')).toBeNull()
  })
  it('goes to the next row once the row is gone', () => {
    expect(focusAfterRemoval([list[0], list[2]], 'b', 'c')).toEqual({ to: 'row', id: 'c' })
  })
  it('goes to the header when there is no next row, or it went too', () => {
    expect(focusAfterRemoval([list[0], list[1]], 'c', null)).toEqual({ to: 'head' })
    expect(focusAfterRemoval([list[0]], 'b', 'c')).toEqual({ to: 'head' })
  })
})
