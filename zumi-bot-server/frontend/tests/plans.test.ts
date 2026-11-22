import { describe, expect, it } from 'vitest'
import { cancelFeedback, EMPTY_PLAN_DRAFT, openFeedback, planLine, planReply, planView, typeFeedback } from '../src/state/plans'
import type { ApprovalItem } from '../src/state/approvals'

const card = (status: ApprovalItem['status'], extra: Partial<ApprovalItem> = {}): ApprovalItem => ({
  type: 'approval',
  id: 'r1',
  toolUseId: 't1',
  toolName: 'ExitPlanMode',
  input: { plan: '# P', planFilePath: '/p.md' },
  description: null,
  reason: null,
  status,
  ts: 1,
  agent: 'writer',
  ...extra
})

describe('planView', () => {
  it('names the agent and carries the plan', () => {
    expect(planView(card('pending'))).toEqual({ heading: 'Plan from Writer', plan: '# P', planFilePath: '/p.md' })
  })
  it('works without a plan or an agent', () => {
    expect(planView(card('pending', { input: {}, agent: undefined }))).toEqual({
      heading: 'Plan for your approval',
      plan: null,
      planFilePath: null
    })
  })
})

describe('planLine', () => {
  it('has a line per finished state', () => {
    expect(planLine(card('approved'))).toBe('Approved')
    expect(planLine(card('sent-back'))).toBe('Sent back')
    expect(planLine(card('unanswered'))).toBe('Not answered')
  })
  it('reads a card saved before plan cards as not approved', () => {
    expect(planLine(card('denied'))).toBe('Not approved')
  })
  it('is "Not answered" for a pending card nobody can answer', () => {
    expect(planLine(card('pending'))).toBe('Not answered')
  })
})

describe('feedback draft', () => {
  it('opens, types and cancels, dropping the text on cancel', () => {
    const open = openFeedback(EMPTY_PLAN_DRAFT)
    expect(open).toEqual({ open: true, feedback: '' })
    const typed = typeFeedback(open, 'add tests')
    expect(typed.feedback).toBe('add tests')
    expect(cancelFeedback(typed)).toEqual(EMPTY_PLAN_DRAFT)
  })
  it('opening again keeps what was typed', () => {
    expect(openFeedback({ open: true, feedback: 'x' })).toEqual({ open: true, feedback: 'x' })
  })
})

describe('planReply', () => {
  it('approves with no feedback', () => {
    expect(planReply(true, { open: false, feedback: '' })).toEqual({ plan: { approve: true } })
  })
  it('sends back with trimmed feedback, or none when blank', () => {
    expect(planReply(false, { open: true, feedback: ' more detail ' })).toEqual({ plan: { approve: false, feedback: 'more detail' } })
    expect(planReply(false, { open: true, feedback: '  ' })).toEqual({ plan: { approve: false } })
  })
})
