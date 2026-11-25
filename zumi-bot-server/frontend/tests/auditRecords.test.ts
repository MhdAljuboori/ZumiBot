import { describe, expect, it } from 'vitest'
import {
  DECISION_OPTIONS,
  EMPTY_CONTROLS,
  dayBound,
  decisionTone,
  decisionWhy,
  durationText,
  filterOf,
  sizeText,
  whoText
} from '../src/state/auditRecords'

const NOW = Date.UTC(2026, 10, 17, 12)

describe('audit page rules', () => {
  it('empty controls make an empty filter; set ones go through trimmed', () => {
    expect(filterOf(EMPTY_CONTROLS, NOW)).toEqual({})
    expect(filterOf({ ...EMPTY_CONTROLS, agent: 'dev', decision: 'deniedByHook', outcome: 'denied', q: '  rm  ' }, NOW)).toEqual({
      agent: 'dev',
      decision: 'deniedByHook',
      outcome: 'denied',
      q: 'rm'
    })
  })

  it('time ranges become from/to', () => {
    expect(filterOf({ ...EMPTY_CONTROLS, range: 'hour' }, NOW)).toEqual({ from: NOW - 3_600_000 })
    expect(filterOf({ ...EMPTY_CONTROLS, range: 'week' }, NOW)).toEqual({ from: NOW - 7 * 86_400_000 })
    const custom = filterOf({ ...EMPTY_CONTROLS, range: 'custom', fromDay: '2026-11-01', toDay: '2026-11-02' }, NOW)
    expect(custom.from).toBe(new Date(2026, 10, 1).getTime())
    expect(custom.to).toBe(new Date(2026, 10, 3).getTime() - 1)
    expect(filterOf({ ...EMPTY_CONTROLS, range: 'custom', fromDay: 'bad' }, NOW)).toEqual({})
    expect(dayBound('2026-13-40x', false)).toBeNull()
  })

  it('words for decisions, durations, sizes and who made the call', () => {
    expect(DECISION_OPTIONS).toHaveLength(15)
    expect(decisionTone({ kind: 'deniedBySandbox', target: 'api.github.com' })).toBe('bad')
    expect(decisionTone({ kind: 'allowedByAllowlist', host: 'example.com' })).toBe('ok')
    expect(decisionWhy({ kind: 'deniedBySandbox', target: 'api.github.com' }, 'auto')).toContain('api.github.com')
    expect(decisionTone({ kind: 'approvedByUser', scope: 'once' })).toBe('ok')
    expect(decisionTone({ kind: 'deniedByRule' })).toBe('bad')
    expect(decisionTone({ kind: 'unanswered' })).toBe('muted')
    expect(decisionWhy({ kind: 'allowedByMode' }, 'manual')).toContain('(manual)')
    expect(decisionWhy({ kind: 'allowedByAgentRule', rule: '["Write"]' }, 'auto')).toContain('["Write"]')
    expect(durationText(null)).toBe('')
    expect(durationText(250)).toBe('250 ms')
    expect(durationText(2500)).toBe('2.5 s')
    expect(durationText(125_000)).toBe('2 min')
    expect(sizeText(512 * 1024 * 1024)).toBe('512.0 MB')
    expect(sizeText(2048 * 1024 * 1024)).toBe('2.0 GB')
    expect(whoText('dev', 'explorer')).toBe('dev › explorer')
  })

  it("a remote agent's rows: ran on its server (muted, never green), or refused by ZumiBot, which runs no tools for it", () => {
    expect(decisionTone({ kind: 'ranRemotely' })).toBe('muted')
    expect(decisionWhy({ kind: 'ranRemotely' }, 'auto')).toMatch(/remote/)
    expect(decisionTone({ kind: 'deniedByZumiBot', why: 'remoteTools' })).toBe('bad')
    expect(decisionWhy({ kind: 'deniedByZumiBot', why: 'remoteTools' }, 'auto')).toMatch(/runs no tools for a remote agent/)
  })

  it('a Run button press: your own action, shown as such and never green or red', () => {
    expect(decisionTone({ kind: 'runByUser' })).toBe('muted')
    expect(DECISION_OPTIONS.find((o) => o.value === 'runByUser')?.label).toBe('Run by you')
    expect(decisionWhy({ kind: 'runByUser' }, 'auto')).toMatch(/pressed Run/)
  })
})
