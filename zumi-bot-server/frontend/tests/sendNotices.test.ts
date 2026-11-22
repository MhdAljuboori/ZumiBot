import { describe, expect, it } from 'vitest'
import { clearNotice, offersRunWorkflow, setNotice, startedNotice, type SendNotice } from '../src/state/sendNotices'

describe('send notices', () => {
  const summary = { id: 'run1', workflowId: 'wf1' }

  it('startedNotice names the workflow and keeps the run to open', () => {
    expect(startedNotice('Daily report', summary)).toEqual({ text: 'Started Daily report', workflowId: 'wf1', runId: 'run1' })
  })

  it('startedNotice falls back to a plain word when the workflow is not in the list yet', () => {
    expect(startedNotice(undefined, summary).text).toBe('Started the workflow')
    expect(startedNotice('  ', summary).text).toBe('Started the workflow')
  })

  it('setNotice and clearNotice work per chat without mutating', () => {
    const a: SendNotice = startedNotice('A', summary)
    const b: SendNotice = startedNotice('B', { id: 'run2', workflowId: 'wf2' })
    const one = Object.freeze({ c1: a })
    const two = setNotice(one, 'c2', b)
    expect(two).toEqual({ c1: a, c2: b })
    expect(clearNotice(two, 'c1')).toEqual({ c2: b })
    expect(one).toEqual({ c1: a })
  })

  it('clearNotice returns the same object when the chat has none', () => {
    const map = { c1: startedNotice('A', summary) }
    expect(clearNotice(map, 'c9')).toBe(map)
  })
})

describe('offersRunWorkflow', () => {
  it('only a chat view that draws the started notice offers /run-workflow in its menu', () => {
    expect(offersRunWorkflow({ compact: false })).toBe(true)
    // The island refuses it.
    expect(offersRunWorkflow({ compact: true })).toBe(false)
  })
})
