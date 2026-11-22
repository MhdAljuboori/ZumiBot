import { describe, expect, it } from 'vitest'
import { routineDef, workflowDef } from '@zumibot/shared/definitionHistory'
import type { Routine } from '@zumibot/shared/routines'
import type { WorkflowInput } from '@zumibot/shared/workflows'
import { emptyDraft } from '../src/state/routineDraft'
import { changesText, restoredRoutine, restoredWorkflow, sourceText, versionTimeText } from '../src/state/versionHistory'

const NOW = new Date(2026, 10, 12, 15, 0).getTime()

describe('versionTimeText', () => {
  it('says today, yesterday, or the date', () => {
    expect(versionTimeText(new Date(2026, 10, 12, 9, 5).getTime(), NOW)).toMatch(/^Today /)
    expect(versionTimeText(new Date(2026, 10, 11, 9, 5).getTime(), NOW)).toMatch(/^Yesterday /)
    expect(versionTimeText(new Date(2026, 10, 3, 9, 5).getTime(), NOW)).not.toMatch(/2026|Today|Yesterday/)
    expect(versionTimeText(new Date(2025, 10, 3, 9, 5).getTime(), NOW)).toMatch(/2025/)
  })
})

describe('sourceText and changesText', () => {
  it('say who saved and what changed', () => {
    expect(sourceText({ source: 'editor' }, NOW)).toBe('Saved by you')
    expect(sourceText({ source: 'zumi-bot' }, NOW)).toBe('Saved by Zumi Bot')
    expect(sourceText({ source: 'earlier' }, NOW)).toBe('Earlier version')
    expect(sourceText({ source: 'restore', restoredFrom: new Date(2026, 10, 12, 9, 5).getTime() }, NOW)).toMatch(/^Restored from Today /)
    expect(changesText({ changes: ['Renamed', 'Prompt changed'] }, false)).toBe('Renamed · Prompt changed')
    expect(changesText({ changes: [] }, true)).toBe('The oldest version kept')
    expect(changesText({ changes: [] }, false)).toBe('Same steps, saved again')
  })
})

describe('restoredWorkflow', () => {
  const draft: WorkflowInput = {
    id: 'w1',
    name: 'Now',
    enabled: true,
    timeZone: 'UTC',
    trigger: { kind: 'manual' },
    steps: [{ id: 't', kind: 'trigger', handle: 'trigger', name: 'Start', x: 0, y: 0 }],
    edges: [],
    notes: [],
    groups: []
  }
  it('puts the version over the draft, keeping its id and on/off, and a webhook keeps the hook’s latest call', () => {
    const sample = { method: 'POST', query: {}, body: { a: 1 }, receivedAt: 3 }
    const def = workflowDef({
      ...draft,
      name: 'Then',
      trigger: { kind: 'webhook', sample: null, filters: [{ field: 'body.a', equals: '1' }] }
    })
    expect(restoredWorkflow(draft, def, sample)).toEqual({
      ...draft,
      name: 'Then',
      trigger: { kind: 'webhook', sample, filters: [{ field: 'body.a', equals: '1' }] }
    })
    expect(restoredWorkflow({ ...draft, enabled: false }, workflowDef({ ...draft, name: 'Then' }), null)).toMatchObject({
      id: 'w1',
      enabled: false,
      name: 'Then'
    })
  })
})

describe('restoredRoutine', () => {
  it('fills the form from the version, keeping the id and on/off', () => {
    const r: Routine = {
      id: 'r1',
      name: 'Old',
      enabled: true,
      timeZone: 'UTC',
      trigger: { kind: 'manual' },
      target: { kind: 'new-chat', agent: 'alpha', cwd: '/w', title: 'T' },
      prompt: 'Old prompt',
      sessionPolicy: 'continue',
      nextRunAt: null,
      createdAt: 1,
      updatedAt: 2
    }
    const draft = { ...emptyDraft('UTC'), id: 'r1', enabled: false, name: 'New', prompt: 'New prompt' }
    const out = restoredRoutine(draft, routineDef(r), [])
    expect(out).toMatchObject({
      id: 'r1',
      enabled: false,
      name: 'Old',
      prompt: 'Old prompt',
      agent: 'alpha',
      cwd: '/w',
      chatTitle: 'T',
      triggerKind: 'manual'
    })
  })
})
