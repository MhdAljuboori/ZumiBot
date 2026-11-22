import { describe, expect, it } from 'vitest'
import { parseAgent, serializeAgent } from '@zumibot/shared/frontmatter'
import { routineChanges, routineDef, workflowChanges, workflowDef } from '@zumibot/shared/definitionHistory'
import { PAUSE_MARKER } from '@zumibot/shared/pause'
import { priceMessage, usageTokens } from '@zumibot/shared/pricing'
import {
  CAP_BLOCK_TEXT,
  capNoticeBody,
  capPausedText,
  capSkipText,
  capUsd,
  dayOf,
  effectiveLimit,
  parseSpendCap,
  raisedLimit,
  reached,
  SPEND_CAP_MAX,
  type CapPause
} from '@zumibot/shared/spendCaps'
import type { Routine } from '@zumibot/shared/routines'
import type { Workflow } from '@zumibot/shared/workflows'

describe('parseSpendCap', () => {
  it('takes amounts above 0 up to the max, rounded to cents, as numbers or text', () => {
    expect(parseSpendCap(5)).toBe(5)
    expect(parseSpendCap('2.5')).toBe(2.5)
    expect(parseSpendCap(' $12.349 ')).toBe(12.35)
    expect(parseSpendCap(SPEND_CAP_MAX)).toBe(SPEND_CAP_MAX)
  })
  it('anything else is no cap', () => {
    for (const v of [0, -1, 0.004, SPEND_CAP_MAX + 1, NaN, Infinity, '', '  ', 'abc', '5 dollars', null, undefined, true, {}])
      expect(parseSpendCap(v)).toBeNull()
  })
})

describe('limits', () => {
  it('the limit is the cap, or a higher one Continue raised it to', () => {
    expect(effectiveLimit(5, undefined)).toBe(5)
    expect(effectiveLimit(5, 12)).toBe(12)
    // A cap raised since by hand wins over an older, lower override.
    expect(effectiveLimit(20, 12)).toBe(20)
  })
  it('going on allows one more cap from what was spent, in cents', () => {
    expect(raisedLimit(5.04, 5)).toBe(10.04)
    expect(raisedLimit(-1, 5)).toBe(5)
  })
  it('a cap is reached at its limit, float noise included', () => {
    expect(reached(4.99, 5)).toBe(false)
    expect(reached(5, 5)).toBe(true)
    expect(reached(0.1 + 0.2, 0.3)).toBe(true)
  })
  it('amounts read as dollars and cents', () => {
    expect(capUsd(5)).toBe('$5.00')
    expect(capUsd(1234.5)).toBe('$1,234.50')
    expect(capUsd(NaN)).toBe('$0.00')
  })
})

describe('words', () => {
  const run: CapPause = {
    scope: { kind: 'workflow', workflowId: 'w', runId: 'r' },
    label: 'Triage',
    spentUsd: 5.04,
    limitUsd: 5,
    capUsd: 5
  }
  it('the pause notice names the scope, the amounts and what Resume allows', () => {
    expect(capPausedText(run)).toBe(
      'Spend cap reached: Workflow “Triage” spent $5.04 of its $5.00 cap for this run. Press Resume to continue; it allows $5.00 more.'
    )
    expect(capPausedText({ ...run, scope: { kind: 'routine', routineId: 'x', runId: 'y' }, label: 'Daily' })).toContain(
      'Routine “Daily” spent $5.04'
    )
    expect(
      capPausedText({ ...run, scope: { kind: 'agent', agent: 'web-dev', day: '2026-11-12' }, label: 'web-dev', limitUsd: 10.04 })
    ).toBe('Spend cap reached: @Web Dev spent $5.04 of its $10.04 daily cap. Press Resume to continue; it allows $5.00 more.')
  })
  it('the notification body and the skip line carry amounts and names only', () => {
    expect(capNoticeBody(run)).toBe('Paused at its spend cap: $5.04 of $5.00.')
    expect(capNoticeBody({ ...run, scope: { kind: 'agent', agent: 'a', day: 'd' } })).toMatch(/^Daily spend cap reached/)
    expect(capSkipText('web-dev')).toBe('@Web Dev reached its daily spend cap')
  })
  it("the hook's cap text still carries the pause marker, so its blocks count as a pause's", () => {
    expect(CAP_BLOCK_TEXT).toContain(PAUSE_MARKER)
  })
})

describe('dayOf', () => {
  it("is the zone's calendar day and its local midnight", () => {
    // 2026-11-12 23:30 UTC is already Nov 13 in Auckland (+13) and still Nov 12 in New York (-5).
    const now = Date.UTC(2026, 10, 12, 23, 30)
    expect(dayOf(now, 'UTC')).toEqual({ day: '2026-11-12', start: Date.UTC(2026, 10, 12) })
    expect(dayOf(now, 'Pacific/Auckland')).toEqual({ day: '2026-11-13', start: Date.UTC(2026, 10, 12, 11) })
    expect(dayOf(now, 'America/New_York')).toEqual({ day: '2026-11-12', start: Date.UTC(2026, 10, 12, 5) })
  })
  it('an unknown zone is UTC', () => {
    expect(dayOf(Date.UTC(2026, 0, 2, 3), 'Not/AZone').day).toBe('2026-01-02')
  })
})

describe('agent files', () => {
  const raw = '---\nname: a\ndescription: d\n---\nBody\n'
  it('dailySpendCap parses as an amount, else null', () => {
    expect((parseAgent('---\nname: a\ndescription: d\ndailySpendCap: 7.5\n---\n') as any).fields.dailySpendCap).toBe(7.5)
    expect((parseAgent('---\nname: a\ndescription: d\ndailySpendCap: lots\n---\n') as any).fields.dailySpendCap).toBeNull()
    expect((parseAgent(raw) as any).fields.dailySpendCap).toBeNull()
  })
  it('is written when set and removed at null', () => {
    const p = parseAgent(raw) as any
    const set = serializeAgent(raw, { ...p.fields, dailySpendCap: 3 }, p.body)
    expect(set).toContain('dailySpendCap: 3\n')
    const q = parseAgent(set) as any
    expect(serializeAgent(set, { ...q.fields, dailySpendCap: null }, q.body)).toBe(raw)
  })
})

describe('saved history', () => {
  const routine = {
    name: 'R',
    timeZone: 'UTC',
    trigger: { kind: 'manual' },
    target: { kind: 'new-chat', agent: 'a', cwd: '/' },
    prompt: 'p'
  } as unknown as Routine
  const workflow = { name: 'W', timeZone: 'UTC', trigger: { kind: 'manual' }, steps: [], edges: [] } as unknown as Workflow
  it('a definition without a cap is as it was before caps existed', () => {
    expect('spendCap' in routineDef(routine)).toBe(false)
    expect('spendCap' in workflowDef(workflow)).toBe(false)
  })
  it('a cap set or changed is a change', () => {
    expect(routineChanges(routineDef(routine), routineDef({ ...routine, spendCap: 2 }))).toEqual(['Settings changed'])
    expect(workflowChanges(workflowDef(workflow), workflowDef({ ...workflow, spendCap: 2 }))).toEqual(['Spend cap changed'])
  })
})

describe('usageTokens', () => {
  it('reads a stream or log usage, the cache write split when given', () => {
    expect(usageTokens({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 40 })).toEqual({
      input: 10,
      output: 5,
      cacheRead: 100,
      cacheWrite5m: 40,
      cacheWrite1h: 0,
      fast: false
    })
    expect(
      usageTokens({ input_tokens: 1, cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 7 }, speed: 'fast' })
    ).toEqual({ input: 1, output: 0, cacheRead: 0, cacheWrite5m: 3, cacheWrite1h: 7, fast: true })
    expect(usageTokens(null)).toBeNull()
    expect(priceMessage('claude-haiku-5-5', usageTokens({ input_tokens: 50_000 })!)).toBeCloseTo(0.005)
  })
})
