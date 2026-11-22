import { describe, expect, it } from 'vitest'
import { checkFeedback, FEEDBACK_MAX_CHARS, parsePlan, planHeading } from '@zumibot/shared/plans'

describe('parsePlan', () => {
  it('reads the plan and its file path', () => {
    expect(parsePlan({ plan: '# P\n- a', planFilePath: '/x/p.md' })).toEqual({ plan: '# P\n- a', planFilePath: '/x/p.md' })
  })
  it('treats missing, blank or non-string parts as null', () => {
    expect(parsePlan({})).toEqual({ plan: null, planFilePath: null })
    expect(parsePlan({ plan: '  \n', planFilePath: 5 })).toEqual({ plan: null, planFilePath: null })
    expect(parsePlan({ allowedPrompts: [] })).toEqual({ plan: null, planFilePath: null })
  })
  it('survives input that is not an object', () => {
    for (const v of [null, undefined, 'x', 3, ['plan']]) expect(parsePlan(v)).toEqual({ plan: null, planFilePath: null })
  })
})

describe('checkFeedback', () => {
  it('returns trimmed text, or null for none or blank', () => {
    expect(checkFeedback(' fix it ')).toBe('fix it')
    expect(checkFeedback(undefined)).toBeNull()
    expect(checkFeedback(null)).toBeNull()
    expect(checkFeedback('  ')).toBeNull()
  })
  it('rejects non-strings and over-long text', () => {
    expect(() => checkFeedback(5)).toThrow(TypeError)
    expect(() => checkFeedback('x'.repeat(FEEDBACK_MAX_CHARS + 1))).toThrow(TypeError)
    expect(checkFeedback('x'.repeat(FEEDBACK_MAX_CHARS))).toHaveLength(FEEDBACK_MAX_CHARS)
  })
})

it('planHeading names the agent when there is one', () => {
  expect(planHeading('helper')).toBe('Plan from Helper')
  expect(planHeading(null)).toBe('Plan for your approval')
})
