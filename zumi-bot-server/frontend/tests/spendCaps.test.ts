import { describe, expect, it } from 'vitest'
import type { Routine, RoutineRun } from '@zumibot/shared/routines'
import type { WorkflowInput } from '@zumibot/shared/workflows'
import { capField, capText, textMeans } from '../src/state/spendCapField'
import { capBlockedOf, capRow } from '../src/state/spendCaps'
import { spendCapRefusal } from '@zumibot/shared/engine'
import type { AgentSummary } from '@zumibot/shared/types'
import { capHoldBanner, visitPauseText } from '../src/state/workflowRun'
import { pauseLabel, policyLabel } from '../src/state/promptFields'
import { draftFromRoutine, draftToInput, emptyDraft } from '../src/state/routineDraft'
import { toInput, withSpendCap } from '../src/state/workflowEditor'
import { restoredWorkflow } from '../src/state/versionHistory'
import { dirty } from '../src/state/workflowCanvas'

describe('the cap field', () => {
  it('empty is no cap, an amount is the cap, anything else an error that changes nothing', () => {
    expect(capField('')).toEqual({ value: null, error: null })
    expect(capField(' 5 ')).toEqual({ value: 5, error: null })
    expect(capField('$2.5')).toEqual({ value: 2.5, error: null })
    expect(capField('0')).toEqual({ value: null, error: 'Enter an amount from $0.01 to $10,000' })
    expect(capField('lots').error).not.toBeNull()
  })
  it('a saved cap reads back as typed, and text that means the value is left alone', () => {
    expect(capText(null)).toBe('')
    expect(capText(5)).toBe('5')
    expect(capText(2.5)).toBe('2.50')
    expect(textMeans('5.0', 5)).toBe(true)
    expect(textMeans('5.', 5)).toBe(true)
    expect(textMeans('', null)).toBe(true)
    expect(textMeans('6', 5)).toBe(false)
    expect(textMeans('x', null)).toBe(false)
  })
})

describe('Settings › Usage › Spend caps rows', () => {
  it('reads the day against its limit, says when it was raised, and offers more once over', () => {
    expect(capRow({ agent: 'dev', capUsd: 5, limitUsd: 5, spentUsd: 2.5, over: false })).toEqual({
      agent: 'dev',
      line: '$2.50 of $5.00 today',
      pct: 50,
      raised: null,
      over: false,
      action: 'Allow $5.00 more today'
    })
    const over = capRow({ agent: 'dev', capUsd: 5, limitUsd: 10.2, spentUsd: 12, over: true })
    expect(over).toMatchObject({ pct: 100, raised: 'Raised from $5.00', over: true })
  })
})

describe("a held run's banner", () => {
  it("names the run's own cap and what Continue allows", () => {
    expect(capHoldBanner({ kind: 'run', at: 1, spentUsd: 5.04, limitUsd: 5, capUsd: 5 })).toEqual({
      text: 'This run reached its $5.00 spend cap ($5.04 spent). Nothing new starts and its agents are paused.',
      action: 'Continue · allows $5.00 more'
    })
  })
  it('names the agent whose day holds it', () => {
    expect(capHoldBanner({ kind: 'agent', agent: 'web-dev', at: 1, spentUsd: 6, limitUsd: 5, capUsd: 5 })).toEqual({
      text: '@Web Dev reached its daily spend cap ($6.00 of $5.00). Its steps wait.',
      action: 'Allow $5.00 more today'
    })
  })
})

describe('a paused step', () => {
  it("says a cap paused it, and how to go on; the user's own pause reads as before", () => {
    expect(visitPauseText({ status: 'running', paused: true, capPaused: true })).toBe(
      'Paused at a spend cap · Continue the run, or press Resume in its chat'
    )
    expect(visitPauseText({ status: 'running', paused: true })).toBe('Paused by you · press Resume in its chat to continue')
    expect(visitPauseText({ status: 'done', resumes: 1 })).toBe('Resumed after a pause')
  })
})

describe('routine run lines', () => {
  const run = (o: Partial<RoutineRun>): RoutineRun => ({
    id: 'r',
    routineId: 'x',
    via: 'schedule',
    status: 'running',
    late: false,
    chatId: null,
    messageId: null,
    startedAt: 1,
    ...o
  })
  it('a cap pause says so, and a run the cap skipped says whose day it was', () => {
    expect(pauseLabel(run({ status: 'paused', capped: true }))).toBe('Paused at its spend cap · press Resume in its chat to continue')
    expect(pauseLabel(run({ status: 'paused' }))).toBe('Paused by you · press Resume in its chat to continue')
    expect(policyLabel(run({ status: 'skipped', skipReason: 'cap', error: '@Dev reached its daily spend cap' }), 2, 'UTC')).toBe(
      'Skipped: @Dev reached its daily spend cap'
    )
  })
})

describe('drafts', () => {
  it("a routine's cap goes into the form and back, none leaving no key", () => {
    const r = {
      id: 'r1',
      name: 'R',
      enabled: true,
      timeZone: 'UTC',
      trigger: { kind: 'manual' },
      target: { kind: 'new-chat', agent: 'a', cwd: '/' },
      prompt: 'p',
      nextRunAt: null,
      createdAt: 1,
      updatedAt: 1
    } as Routine
    expect(emptyDraft('UTC').spendCap).toBeNull()
    expect(draftFromRoutine({ ...r, spendCap: 4 }).spendCap).toBe(4)
    expect(draftToInput({ ...draftFromRoutine(r), spendCap: 4 }).spendCap).toBe(4)
    expect(draftToInput(draftFromRoutine(r))).not.toHaveProperty('spendCap')
  })
  it("a workflow's cap is set and cleared as a key, so a draft without one equals one saved without", () => {
    const w: WorkflowInput = {
      id: 'w',
      name: 'W',
      enabled: false,
      timeZone: 'UTC',
      trigger: { kind: 'manual' },
      steps: [],
      edges: [],
      notes: [],
      groups: []
    }
    const capped = withSpendCap(w, 3)
    expect(capped.spendCap).toBe(3)
    expect(withSpendCap(capped, null)).not.toHaveProperty('spendCap')
    expect(dirty(withSpendCap(capped, null), w)).toBe(false)
    expect(toInput({ ...w, spendCap: 3, nextRunAt: null, createdAt: 1, updatedAt: 1 }).spendCap).toBe(3)
    expect(
      restoredWorkflow(
        capped,
        { name: 'W', timeZone: 'UTC', trigger: { kind: 'manual' }, steps: [], edges: [], notes: [], groups: [] },
        null
      ).spendCap
    ).toBeUndefined()
  })
})

describe('capBlockedOf', () => {
  const agent = (name: string, provider?: 'codex' | 'acp'): AgentSummary => ({
    filePath: `/a/${name}.md`,
    name,
    description: '',
    color: null,
    icon: null,
    error: null,
    builtIn: false,
    ...(provider ? { provider } : {})
  })
  const agents = [agent('ui'), agent('cx', 'codex'), agent('gem', 'acp')]
  it('is the fixed sentence for an agent whose engine reports no cost, and null for one whose cap can hold', () => {
    expect(capBlockedOf('gem', agents)).toBe(spendCapRefusal('acp', 'gem'))
    expect(capBlockedOf('ui', agents)).toBeNull()
    expect(capBlockedOf('cx', agents)).toBeNull()
    expect(capBlockedOf('gone', agents)).toBeNull()
  })
})
