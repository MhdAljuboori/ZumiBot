import { describe, expect, it } from 'vitest'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import type { Routine, RoutineRun, RoutinesSnapshot } from '@zumibot/shared/routines'
import { anyWaiting, routineRows, targetWarning } from '../src/state/routinesList'

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 9, 27, 0, 0)
const agent = (name: string, error: string | null = null) => ({ name, error }) as AgentSummary
const chat = (id: string, agentName = 'Scout') => ({ id, agentName }) as ChatMeta

const routine = (over: Partial<Routine> = {}): Routine => ({
  id: 'r1',
  name: 'Daily AI digest',
  enabled: true,
  timeZone: 'UTC',
  trigger: { kind: 'schedule', schedule: { freq: 'daily', time: '07:00', days: [0, 1, 2, 3, 4, 5, 6] } },
  target: { kind: 'new-chat', agent: 'Scout', cwd: '/x' },
  prompt: 'go',
  nextRunAt: NOW + 9 * HOUR,
  createdAt: 0,
  updatedAt: 0,
  ...over
})
const run = (over: Partial<RoutineRun>): RoutineRun => ({
  id: 'u' + Math.random(),
  routineId: 'r1',
  via: 'schedule',
  status: 'done',
  late: false,
  chatId: null,
  messageId: null,
  startedAt: 1,
  ...over
})
const snap = (routines: Routine[], runs: Record<string, RoutineRun[]> = {}): RoutinesSnapshot => ({ routines, runs })
const agents = [agent('Scout')]

describe('routineRows', () => {
  it('describes a daily routine and its next run', () => {
    const [row] = routineRows(snap([routine()]), agents, [], NOW, '')
    expect(row.subline).toBe('Every day at 7:00 AM · next in 9h')
    expect(row.icon).toBe('schedule')
  })
  it('uses minutes and days for near and far runs', () => {
    expect(routineRows(snap([routine({ nextRunAt: NOW + 25 * 60_000 })]), agents, [], NOW, '')[0].subline).toMatch(/next in 25m$/)
    expect(routineRows(snap([routine({ nextRunAt: NOW + 49 * HOUR })]), agents, [], NOW, '')[0].subline).toMatch(/next in 2d$/)
  })
  it('names webhook and manual triggers', () => {
    const rows = routineRows(
      snap([
        routine({ id: 'a', name: 'A', trigger: { kind: 'webhook', sample: null } }),
        routine({ id: 'b', name: 'B', trigger: { kind: 'manual' } })
      ]),
      agents,
      [],
      NOW,
      ''
    )
    expect(rows.map((r) => [r.icon, r.subline])).toEqual([
      ['webhook', 'Webhook'],
      ['manual', 'Manual']
    ])
  })
  it('marks off rows and keeps their schedule without a next run', () => {
    const [row] = routineRows(snap([routine({ enabled: false })]), agents, [], NOW, '')
    expect(row.enabled).toBe(false)
    expect(row.subline).toBe('Every day at 7:00 AM')
    expect(routineRows(snap([routine()]), agents, [], NOW, '')[0].enabled).toBe(true)
  })
  it('takes the dot from the newest run and appends waiting', () => {
    const runs = {
      r1: [run({ status: 'done', startedAt: 5 }), run({ status: 'failed', startedAt: 9 }), run({ status: 'done', startedAt: 2 })]
    }
    expect(routineRows(snap([routine()], runs), agents, [], NOW, '')[0].dot).toBe('failed')
    const waiting = { r1: [run({ status: 'waiting', startedAt: 9 })] }
    const [row] = routineRows(snap([routine()], waiting), agents, [], NOW, '')
    expect(row.dot).toBe('waiting')
    expect(row.subline.endsWith(' · waiting for approval')).toBe(true)
    expect(routineRows(snap([routine()]), agents, [], NOW, '')[0].dot).toBeNull()
  })
  it('shows a run waiting for the usage limit without a dot or the approval badge', () => {
    const s = snap([routine()], {
      r1: [run({ status: 'failed', startedAt: 5 }), run({ status: 'limited', startedAt: 9, resumeAt: NOW + HOUR })]
    })
    const [row] = routineRows(s, agents, [], NOW, '')
    expect(row.dot).toBeNull()
    expect(row.subline.endsWith(' · waiting for limit reset')).toBe(true)
    expect(anyWaiting(s)).toBe(false)
  })
  it('shows a run the user paused without a dot or the approval badge', () => {
    const s = snap([routine()], { r1: [run({ status: 'failed', startedAt: 5 }), run({ status: 'paused', startedAt: 9 })] })
    const [row] = routineRows(s, agents, [], NOW, '')
    expect(row.dot).toBeNull()
    expect(row.subline.endsWith(' · paused by you')).toBe(true)
    expect(anyWaiting(s)).toBe(false)
  })
  it('keeps the dot of the newest real run when later calls were skipped', () => {
    const runs = { r1: [run({ status: 'failed', startedAt: 5 }), run({ status: 'skipped', startedAt: 9 })] }
    expect(routineRows(snap([routine()], runs), agents, [], NOW, '')[0].dot).toBe('failed')
    expect(routineRows(snap([routine()], { r1: [run({ status: 'skipped', startedAt: 9 })] }), agents, [], NOW, '')[0].dot).toBeNull()
  })
  it('filters by name ignoring case and sorts by name', () => {
    const s = snap([routine({ id: 'b', name: 'Zed' }), routine({ id: 'a', name: 'alpha digest' })])
    expect(routineRows(s, agents, [], NOW, '').map((r) => r.id)).toEqual(['a', 'b'])
    expect(routineRows(s, agents, [], NOW, 'DIGEST').map((r) => r.id)).toEqual(['a'])
  })
  it('warns about a deleted agent or a removed chat', () => {
    const gone = routine({ target: { kind: 'new-chat', agent: 'Ghost', cwd: '/x' } })
    expect(routineRows(snap([gone]), agents, [], NOW, '')[0].warning).toBe('Agent "Ghost" not found')
    const chatRoutine = routine({ target: { kind: 'chat', chatId: 'c1' } })
    expect(routineRows(snap([chatRoutine]), agents, [], NOW, '')[0].warning).toBe('Chat not found')
    expect(targetWarning(chatRoutine, agents, [chat('c1')])).toBeNull()
    expect(targetWarning(routine({ target: { kind: 'new-group', members: ['Scout', 'Ghost'], role: '', cwd: '/x' } }), agents, [])).toBe(
      'Agent "Ghost" not found'
    )
  })
  it("agrees with the runner: a broken agent is missing, and so is an existing chat's agent", () => {
    const broken = [agent('Scout', 'bad frontmatter')]
    expect(targetWarning(routine(), broken, [])).toBe('Agent "Scout" not found')
    const chatRoutine = routine({ target: { kind: 'chat', chatId: 'c1' } })
    expect(targetWarning(chatRoutine, agents, [chat('c1', 'Ghost')])).toBe('Agent "Ghost" not found')
    expect(targetWarning(chatRoutine, broken, [chat('c1')])).toBe('Agent "Scout" not found')
    // An existing group chat runs with the members it has left.
    const group = { id: 'c1', agentName: '', group: { members: ['Ghost', 'Scout'] } } as ChatMeta
    expect(targetWarning(chatRoutine, agents, [group])).toBeNull()
  })
})

describe('anyWaiting', () => {
  it('is true when any run waits', () => {
    expect(anyWaiting(snap([routine()]))).toBe(false)
    expect(anyWaiting(snap([routine()], { r1: [run({ status: 'done' }), run({ status: 'waiting' })] }))).toBe(true)
  })
})
