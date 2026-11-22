import { describe, expect, it } from 'vitest'
import { CLONE_TITLE_MAX, HANDOFF_MAX_CHARS } from '@zumibot/shared/roomClone'
import {
  canCreate,
  canSummarizeView,
  closeAsks,
  cloneReducer,
  handoffCount,
  handoffOf,
  handoffPreview,
  initialClone,
  primaryOf,
  summaryOffered,
  type CloneEvent,
  type CloneState
} from '../src/state/cloneRoom'

const run = (s: CloneState, ...events: CloneEvent[]): CloneState => events.reduce(cloneReducer, s)
const start = () => initialClone('API room', [])
const reviewing = (text = 'x') => run(start(), { type: 'option', option: 'summary' }, { type: 'write' }, { type: 'summaryReady', text })

describe('initialClone', () => {
  it('starts on choose with the next copy title and Start over', () => {
    expect(start()).toMatchObject({
      step: 'choose',
      name: 'API room (2)',
      option: 'fresh',
      draft: null,
      text: '',
      edited: false,
      error: null
    })
  })
  it('skips taken titles', () => {
    expect(initialClone('API room', ['API room (2)']).name).toBe('API room (3)')
  })
})

describe('summary flow', () => {
  it('write goes to writing, summaryReady to review with the draft untouched', () => {
    const w = run(start(), { type: 'option', option: 'summary' }, { type: 'write' })
    expect(w.step).toBe('writing')
    const r = cloneReducer(w, { type: 'summaryReady', text: 'x' })
    expect(r).toMatchObject({ step: 'review', draft: 'x', text: 'x', edited: false })
  })
  it('edit changes the text and marks it edited', () => {
    expect(cloneReducer(reviewing(), { type: 'edit', text: 'y' })).toMatchObject({ step: 'review', draft: 'x', text: 'y', edited: true })
  })
  it('back keeps the draft and the edits; write again goes straight to review', () => {
    const b = run(reviewing(), { type: 'edit', text: 'y' }, { type: 'back' })
    expect(b).toMatchObject({ step: 'choose', draft: 'x', text: 'y', edited: true })
    expect(cloneReducer(b, { type: 'write' })).toMatchObject({ step: 'review', text: 'y', draft: 'x' })
  })
  it('rewrite goes to writing and the next summary replaces draft and edits', () => {
    const w = run(reviewing(), { type: 'edit', text: 'y' }, { type: 'rewrite' })
    expect(w.step).toBe('writing')
    expect(cloneReducer(w, { type: 'summaryReady', text: 'z' })).toMatchObject({ step: 'review', draft: 'z', text: 'z', edited: false })
  })
  it('cancelWriting goes back to choose and drops nothing', () => {
    const w = run(reviewing(), { type: 'edit', text: 'y' }, { type: 'rewrite' })
    expect(cloneReducer(w, { type: 'cancelWriting' })).toMatchObject({ step: 'choose', draft: 'x', text: 'y', edited: true })
  })
  it('cancelWriting on a first summary leaves no draft', () => {
    const w = run(start(), { type: 'option', option: 'summary' }, { type: 'write' }, { type: 'cancelWriting' })
    expect(w).toMatchObject({ step: 'choose', draft: null })
  })
})

describe('failure', () => {
  const failed = () => run(start(), { type: 'option', option: 'summary' }, { type: 'write' }, { type: 'summaryFailed', error: 'nope' })
  it('summaryFailed from writing shows the error', () => {
    expect(failed()).toMatchObject({ step: 'failed', error: 'nope' })
  })
  it('write from failed tries again; back returns to choose', () => {
    expect(cloneReducer(failed(), { type: 'write' }).step).toBe('writing')
    expect(cloneReducer(failed(), { type: 'back' }).step).toBe('choose')
  })
  it('a failed rewrite keeps the old draft', () => {
    const f = run(reviewing(), { type: 'rewrite' }, { type: 'summaryFailed', error: 'e' })
    expect(f).toMatchObject({ step: 'failed', draft: 'x', text: 'x' })
  })
})

describe('creating', () => {
  it('create from choose (Start over) and from review set where to return', () => {
    expect(cloneReducer(start(), { type: 'create' })).toMatchObject({ step: 'creating', from: 'choose' })
    expect(cloneReducer(reviewing(), { type: 'create' })).toMatchObject({ step: 'creating', from: 'review' })
  })
  it('create while creating is the same state object', () => {
    const c = cloneReducer(start(), { type: 'create' })
    expect(cloneReducer(c, { type: 'create' })).toBe(c)
  })
  it('createFailed returns to the step it came from with the error', () => {
    expect(run(start(), { type: 'create' }, { type: 'createFailed', error: 'bad' })).toMatchObject({ step: 'choose', error: 'bad' })
    expect(run(reviewing(), { type: 'create' }, { type: 'createFailed', error: 'bad' })).toMatchObject({
      step: 'review',
      error: 'bad',
      text: 'x'
    })
  })
  it('create is refused when the room cannot be created yet', () => {
    const s = run(start(), { type: 'name', name: '  ' })
    expect(cloneReducer(s, { type: 'create' })).toBe(s)
    const w = run(start(), { type: 'option', option: 'summary' })
    expect(cloneReducer(w, { type: 'create' })).toBe(w)
  })
})

describe('events that do not fit the step', () => {
  it('return the same state object', () => {
    const s = start()
    const events: CloneEvent[] = [
      { type: 'edit', text: 'a' },
      { type: 'rewrite' },
      { type: 'back' },
      { type: 'cancelWriting' },
      { type: 'summaryReady', text: 'a' },
      { type: 'summaryFailed', error: 'e' },
      { type: 'createFailed', error: 'e' }
    ]
    for (const e of events) expect(cloneReducer(s, e)).toBe(s)
  })
  it('name and option are only taken on choose', () => {
    const r = reviewing()
    expect(cloneReducer(r, { type: 'name', name: 'z' })).toBe(r)
    expect(cloneReducer(r, { type: 'option', option: 'fresh' })).toBe(r)
  })
  it('name and option change choose', () => {
    expect(run(start(), { type: 'name', name: 'N' }, { type: 'option', option: 'summary' })).toMatchObject({ name: 'N', option: 'summary' })
  })
})

describe('canCreate', () => {
  it('needs a trimmed name within the cap', () => {
    expect(canCreate(start())).toBe(true)
    expect(canCreate({ ...start(), name: '  ' })).toBe(false)
    expect(canCreate({ ...start(), name: 'a'.repeat(CLONE_TITLE_MAX) })).toBe(true)
    expect(canCreate({ ...start(), name: 'a'.repeat(CLONE_TITLE_MAX + 1) })).toBe(false)
  })
  it('in review also needs a text within the cap', () => {
    expect(canCreate(reviewing())).toBe(true)
    expect(canCreate({ ...reviewing(), text: '  \n ' })).toBe(false)
    expect(canCreate({ ...reviewing(), text: 'a'.repeat(HANDOFF_MAX_CHARS) })).toBe(true)
    expect(canCreate({ ...reviewing(), text: 'a'.repeat(HANDOFF_MAX_CHARS + 1) })).toBe(false)
  })
  it('is false while writing or creating', () => {
    expect(canCreate({ ...start(), step: 'writing' })).toBe(false)
    expect(canCreate({ ...start(), step: 'creating' })).toBe(false)
  })
})

describe('handoffOf', () => {
  it('is null for Start over', () => {
    expect(handoffOf(start())).toBeNull()
    expect(handoffOf({ ...reviewing(), option: 'fresh' })).toBeNull()
  })
  it('is the edited text for a summary', () => {
    expect(handoffOf(run(reviewing(), { type: 'edit', text: 'mine' }))).toBe('mine')
  })
})

describe('canSummarizeView', () => {
  const user = { type: 'user' as const, id: 'u', text: 'hi', ts: 1 }
  const running = { type: 'assistant' as const, id: 'a', text: 'x', ts: 1, agent: 'w', turn: 't' }
  it('leaves a room not loaded yet to the server', () => {
    expect(canSummarizeView(undefined)).toBe(true)
    expect(canSummarizeView({ items: [], start: null })).toBe(true)
  })
  it('is true with older pages, even when none of the loaded items count', () => {
    expect(canSummarizeView({ items: [running], start: 40 })).toBe(true)
  })
  it('needs a finished message when everything is loaded', () => {
    expect(canSummarizeView({ items: [], start: 0 })).toBe(false)
    expect(canSummarizeView({ items: [running], start: 0 })).toBe(false)
    expect(canSummarizeView({ items: [user], start: 0 })).toBe(true)
  })
})

describe('primaryOf', () => {
  it('Start over creates; With summary writes', () => {
    expect(primaryOf(start(), true)).toEqual({ kind: 'create', enabled: true })
    expect(primaryOf(run(start(), { type: 'option', option: 'summary' }), true)).toEqual({ kind: 'write', enabled: true })
  })
  it('write needs something to summarize, unless a draft is kept', () => {
    const summary = run(start(), { type: 'option', option: 'summary' })
    expect(primaryOf(summary, false)).toEqual({ kind: 'write', enabled: false })
    expect(primaryOf(run(reviewing(), { type: 'back' }), false)).toEqual({ kind: 'write', enabled: true })
  })
  it('needs a name on choose', () => {
    const blank = run(start(), { type: 'name', name: ' ' })
    expect(primaryOf(blank, true)?.enabled).toBe(false)
    expect(primaryOf(run(blank, { type: 'option', option: 'summary' }), true)?.enabled).toBe(false)
  })
  it('review creates while the text is within the cap', () => {
    expect(primaryOf(reviewing(), true)).toEqual({ kind: 'create', enabled: true })
    expect(primaryOf(run(reviewing(), { type: 'edit', text: ' ' }), true)).toEqual({ kind: 'create', enabled: false })
  })
  it('failed retries; writing has none; creating waits', () => {
    expect(primaryOf(run(start(), { type: 'write' }, { type: 'summaryFailed', error: 'e' }), true)).toEqual({
      kind: 'retry',
      enabled: true
    })
    expect(primaryOf(run(start(), { type: 'write' }), true)).toBeNull()
    expect(primaryOf(run(start(), { type: 'create' }), true)).toEqual({ kind: 'create', enabled: false })
  })
})

describe('summaryOffered', () => {
  it('is off only with nothing to summarize and no kept draft', () => {
    expect(summaryOffered(start(), true)).toBe(true)
    expect(summaryOffered(start(), false)).toBe(false)
    expect(summaryOffered(run(reviewing(), { type: 'back' }), false)).toBe(true)
  })
})

describe('closeAsks', () => {
  it('asks only when edits would be lost', () => {
    expect(closeAsks(start())).toBe(false)
    expect(closeAsks(reviewing())).toBe(false)
    const edited = run(reviewing(), { type: 'edit', text: 'y' })
    expect(closeAsks(edited)).toBe(true)
    expect(closeAsks(run(edited, { type: 'back' }))).toBe(true)
    expect(closeAsks(run(edited, { type: 'rewrite' }, { type: 'summaryFailed', error: 'e' }))).toBe(true)
  })
  it('does not ask while writing (Rewrite already asked) or creating', () => {
    const edited = run(reviewing(), { type: 'edit', text: 'y' })
    expect(closeAsks(run(edited, { type: 'rewrite' }))).toBe(false)
    expect(closeAsks(run(edited, { type: 'create' }))).toBe(false)
  })
})

describe('handoffCount', () => {
  it('stays hidden up to 90 % of the cap', () => {
    expect(handoffCount('')).toBeNull()
    expect(handoffCount('a'.repeat(HANDOFF_MAX_CHARS * 0.9))).toBeNull()
  })
  it('shows past 90 %, and marks over the cap', () => {
    expect(handoffCount('a'.repeat(HANDOFF_MAX_CHARS * 0.9 + 1))).toEqual({ label: '10,801 / 12,000', over: false })
    expect(handoffCount('a'.repeat(HANDOFF_MAX_CHARS))).toEqual({ label: '12,000 / 12,000', over: false })
    expect(handoffCount('a'.repeat(HANDOFF_MAX_CHARS + 1))).toEqual({ label: '12,001 / 12,000', over: true })
  })
})

describe('handoffPreview', () => {
  it('takes the first two lines with text, without Markdown line markers', () => {
    expect(handoffPreview('## Goal\n\nShip the **login** API.\n## Decisions\n- JWT')).toBe('Goal\nShip the login API.')
  })
  it('strips list, quote and numbered markers', () => {
    expect(handoffPreview('- one\n> two\n3. three')).toBe('one\ntwo')
    expect(handoffPreview('1) first\n* second')).toBe('first\nsecond')
  })
  it('keeps a single line as it is', () => {
    expect(handoffPreview('  just this  ')).toBe('just this')
  })
})
