import { describe, expect, it } from 'vitest'
import type { Workflow, WorkflowDef, WorkflowInput } from '@zumibot/shared/workflows'
import { conditionShown, toInput, withConditionText, withLimitPolicy, withMissedPolicy } from '../src/state/workflowEditor'
import { restoredWorkflow } from '../src/state/versionHistory'
import { dirty } from '../src/state/workflowCanvas'
import { emptyHistory, record, redo, undo } from '../src/state/workflowHistory'

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
const saved = (extra: Partial<Workflow>): Workflow => ({ ...w, id: 'w', nextRunAt: null, createdAt: 1, updatedAt: 1, ...extra }) as Workflow
const def = (extra: Partial<WorkflowDef> = {}): WorkflowDef => ({
  name: 'W',
  timeZone: 'UTC',
  trigger: { kind: 'manual' },
  steps: [],
  edges: [],
  notes: [],
  groups: [],
  ...extra
})

describe('workflow run policies in the draft', () => {
  it('a loaded workflow carries its policies into the draft, so a save sends them back', () => {
    const d = toInput(saved({ limitPolicy: 'skip', missedPolicy: 'skip' }))
    expect(d.limitPolicy).toBe('skip')
    expect(d.missedPolicy).toBe('skip')
    expect(toInput(saved({}))).not.toHaveProperty('limitPolicy')
  })

  it('choosing the default removes the key, so a draft without one equals one saved without', () => {
    const skip = withLimitPolicy(withMissedPolicy(w, 'skip'), 'skip')
    expect(skip).toMatchObject({ limitPolicy: 'skip', missedPolicy: 'skip' })
    const back = withLimitPolicy(withMissedPolicy(skip, 'wait'), 'wait')
    expect(back).not.toHaveProperty('limitPolicy')
    expect(back).not.toHaveProperty('missedPolicy')
    expect(dirty(back, w)).toBe(false)
  })

  it('a restored version brings its policies, or clears them when it had none', () => {
    expect(restoredWorkflow(w, def({ limitPolicy: 'skip', missedPolicy: 'skip' }), null)).toMatchObject({
      limitPolicy: 'skip',
      missedPolicy: 'skip'
    })
    const cleared = restoredWorkflow(withLimitPolicy(w, 'skip'), def(), null)
    expect(cleared).not.toHaveProperty('limitPolicy')
    expect(cleared).not.toHaveProperty('missedPolicy')
  })

  it('undo and redo bring them back', () => {
    const after = withLimitPolicy(w, 'skip')
    const h = record(emptyHistory, w, after, null, 0)
    const u = undo(h, after)!
    expect(u.w).not.toHaveProperty('limitPolicy')
    expect(redo(u.h, u.w)!.w.limitPolicy).toBe('skip')
  })
})

describe('webhook condition in the draft', () => {
  const hook: WorkflowInput = { ...w, trigger: { kind: 'webhook', sample: null, filters: [] } }

  it('is stored only when not blank (typed text is kept as typed; the server trims)', () => {
    expect(withConditionText(hook, 'The CI failed').trigger).toMatchObject({ condition: 'The CI failed' })
    expect(withConditionText(withConditionText(hook, 'x'), '   ').trigger).not.toHaveProperty('condition')
    expect(withConditionText(w, 'x')).toBe(w)
  })

  it('keeps the typed text while editing, so a trailing space is not eaten', () => {
    expect(withConditionText(hook, 'The CI ').trigger).toMatchObject({ condition: 'The CI ' })
  })

  it('shows while Jev is on or a condition is saved, for a webhook only', () => {
    expect(conditionShown(w.trigger, true)).toBe(false)
    expect(conditionShown(hook.trigger, false)).toBe(false)
    expect(conditionShown(hook.trigger, true)).toBe(true)
    expect(conditionShown({ kind: 'webhook', sample: null, filters: [], condition: 'x' }, false)).toBe(true)
  })
})
