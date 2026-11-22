import { describe, expect, it } from 'vitest'
import type { ProcessInfo } from '@zumibot/shared/processes'
import {
  countsAfter,
  wakeLabel,
  joinLog,
  LOG_VIEW_MAX,
  logBehind,
  processActions,
  processesBadge,
  processMark,
  processRows,
  stateLabel
} from '../src/state/processes'

const p = (over: Partial<ProcessInfo>): ProcessInfo => ({
  id: 'p_0000000001',
  chatId: 'c',
  name: 'web',
  command: 'npm run dev',
  cwd: '/r',
  startedBy: 'web-dev',
  startedAt: 0,
  endedAt: null,
  state: 'running',
  exitCode: null,
  signal: null,
  stoppedBy: null,
  note: null,
  restarts: 0,
  until: 0,
  out: 0,
  wake: null,
  ...over
})

describe('process rows', () => {
  it("says each state in the panel's words", () => {
    expect(stateLabel(p({}))).toEqual({ text: 'Running', tone: 'running' })
    expect(stateLabel(p({ state: 'exited', exitCode: 0 }))).toEqual({ text: 'Exited (code 0)', tone: 'ok' })
    expect(stateLabel(p({ state: 'exited', exitCode: 1 }))).toEqual({ text: 'Exited (code 1)', tone: 'bad' })
    expect(stateLabel(p({ state: 'exited', signal: 'SIGSEGV' })).text).toBe('Ended by SIGSEGV')
    expect(stateLabel(p({ state: 'stopped', stoppedBy: 'user' })).text).toBe('Stopped by you')
    expect(stateLabel(p({ state: 'stopped', stoppedBy: 'archive' })).text).toBe('Stopped at archive')
    expect(stateLabel(p({ state: 'lost' })).text).toBe('Lost at restart')
    expect(stateLabel(p({ state: 'lost', note: 'ended at start' })).text).toBe('Lost at restart (ended)')
    expect(stateLabel(p({ state: 'failed', note: 'ENOENT' }))).toEqual({ text: 'Failed to start (ENOENT)', tone: 'bad' })
  })

  it("lists running first, then ended newest first, with uptime or age and the agent's display name", () => {
    const rows = processRows(
      [
        p({ id: 'p_a', state: 'exited', exitCode: 0, endedAt: 50_000 }),
        p({ id: 'p_b', startedAt: 40_000 }),
        p({ id: 'p_c', state: 'stopped', stoppedBy: 'user', endedAt: 90_000 })
      ],
      100_000
    )
    expect(rows.map((r) => r.id)).toEqual(['p_b', 'p_c', 'p_a'])
    expect(rows[0]).toMatchObject({ time: 'up 1m', running: true, by: 'Web Dev' })
    expect(rows[1].time).toBe('10s ago')
  })

  it('badges the menu row and marks the header only while something runs', () => {
    expect(processesBadge([])).toBeNull()
    expect(processesBadge([p({}), p({ state: 'exited' })])).toEqual({ text: '1 running', live: true })
    expect(processesBadge([p({ state: 'exited' }), p({ state: 'lost' })])).toEqual({ text: '2', live: false })
    expect(processMark(0)).toBeNull()
    expect(processMark(1)).toEqual({ count: '', label: '1 process running' })
    expect(processMark(3)).toEqual({ count: '3', label: '3 processes running' })
  })

  it('keeps per-chat counts from change events', () => {
    const a = countsAfter({}, { chatId: 'c1', running: 2 })
    expect(a).toEqual({ c1: 2 })
    expect(countsAfter(a, { chatId: 'c1', running: 2 })).toBe(a)
    expect(countsAfter(a, { chatId: 'c1', running: 0 })).toEqual({})
  })

  it('offers Stop while running, Forget once ended, Restart unless archived', () => {
    expect(processActions(p({}), false)).toEqual({ stop: true, restart: true, forget: false })
    expect(processActions(p({ state: 'exited' }), false)).toEqual({ stop: false, restart: true, forget: true })
    expect(processActions(p({ state: 'exited' }), true)).toEqual({ stop: false, restart: false, forget: true })
    expect(processActions(undefined, false)).toEqual({ stop: false, restart: false, forget: false })
  })
})

describe('the live log', () => {
  it('appends a read that starts where the view ends and replaces anything else', () => {
    let v = joinLog(null, 'p1', { text: 'a\n', from: 0, to: 2, dropped: 0 })
    v = joinLog(v, 'p1', { text: 'b\n', from: 2, to: 4, dropped: 0 })
    expect(v).toEqual({ id: 'p1', from: 0, to: 4, text: 'a\nb\n', dropped: 0, trimmed: false })
    // A gap (the view fell behind what the server keeps): start over from the read.
    expect(joinLog(v, 'p1', { text: 'z\n', from: 900, to: 902, dropped: 896 })).toMatchObject({ from: 900, text: 'z\n', dropped: 896 })
    // Another process's read never joins this one.
    expect(joinLog(v, 'p2', { text: 'x', from: 4, to: 5, dropped: 0 })).toMatchObject({ id: 'p2', text: 'x' })
    expect(logBehind(v, 4)).toBe(false)
    expect(logBehind(v, 9)).toBe(true)
    expect(logBehind(null, 0)).toBe(true)
  })

  it('keeps only the newest whole lines past its cap', () => {
    const line = 'x'.repeat(99) + '\n'
    let v = joinLog(null, 'p1', { text: line.repeat(Math.ceil(LOG_VIEW_MAX / 100)), from: 0, to: LOG_VIEW_MAX, dropped: 0 })
    v = joinLog(v, 'p1', { text: 'last\n', from: LOG_VIEW_MAX, to: LOG_VIEW_MAX + 5, dropped: 0 })
    expect(v.text.length).toBeLessThanOrEqual(LOG_VIEW_MAX)
    expect(v.text.startsWith('x')).toBe(true)
    expect(v.text.endsWith('last\n')).toBe(true)
    expect(v.trimmed).toBe(true)
  })
})

describe('wakeLabel', () => {
  it('says when the rule wakes the agent and how much of it is used', () => {
    expect(wakeLabel(null)).toBeNull()
    expect(wakeLabel({ on: 'exit', patterns: [], times: 1, fired: 0, note: null })).toBe('Wakes the agent when it exits')
    expect(wakeLabel({ on: 'fail', patterns: [], times: 1, fired: 1, note: null })).toBe('Wakes the agent if it fails · used')
    expect(wakeLabel({ on: 'match', patterns: ['FAIL', 'Error:'], times: 3, fired: 1, note: null })).toBe(
      'Wakes the agent on lines with "FAIL", "Error:" · 1 of 3 used'
    )
  })
})
