import { describe, expect, it } from 'vitest'
import { isBlankBox, replyOptionsOf } from '../src/state/replyOptions'

const o = {
  on: true,
  suggested: { after: 'a1', options: ['Native', 'Subagent-driven'] },
  lastItemId: 'a1',
  running: false,
  draftEmpty: true
}
const one = { ...o, suggested: { after: 'a1', options: ['Yes, commit it'] } }

describe('replyOptionsOf', () => {
  it('two or three options are buttons', () => {
    expect(replyOptionsOf(o)).toEqual({ buttons: ['Native', 'Subagent-driven'] })
    expect(replyOptionsOf({ ...o, suggested: { after: 'a1', options: ['A', 'B', 'C'] } })).toEqual({ buttons: ['A', 'B', 'C'] })
  })

  it('the buttons carry the question they answer and the summary before it', () => {
    const asked = { ...o, suggested: { ...o.suggested, question: 'Which way should I build it?', summary: 'Wrote the plan.' } }
    expect(replyOptionsOf(asked)).toEqual({
      buttons: ['Native', 'Subagent-driven'],
      question: 'Which way should I build it?',
      summary: 'Wrote the plan.'
    })
  })

  it('one option is the placeholder', () => {
    expect(replyOptionsOf(one)).toEqual({ placeholder: 'Yes, commit it' })
  })

  it('nothing while the switch is off', () => {
    expect(replyOptionsOf({ ...o, on: false })).toBeNull()
    expect(replyOptionsOf({ ...one, on: false })).toBeNull()
  })

  it('nothing while the chat runs', () => {
    expect(replyOptionsOf({ ...o, running: true })).toBeNull()
  })

  it('nothing once the reply they were for is no longer last', () => {
    expect(replyOptionsOf({ ...o, lastItemId: 'u2' })).toBeNull()
    expect(replyOptionsOf({ ...o, lastItemId: null })).toBeNull()
  })

  it('nothing without options to show', () => {
    expect(replyOptionsOf({ ...o, suggested: undefined })).toBeNull()
    expect(replyOptionsOf({ ...o, suggested: { after: 'a1', options: [] } })).toBeNull()
    expect(replyOptionsOf({ ...o, suggested: { after: 'a1', options: ['A', 'B', 'C', 'D'] } })).toBeNull()
  })

  it('nothing once the user starts a message of their own', () => {
    expect(replyOptionsOf({ ...o, draftEmpty: false })).toBeNull()
    expect(replyOptionsOf({ ...one, draftEmpty: false })).toBeNull()
  })
})

describe('isBlankBox', () => {
  it('only a lone empty paragraph is a blank box', () => {
    expect(isBlankBox({ type: 'doc', content: [{ type: 'paragraph' }] })).toBe(true)
    expect(isBlankBox({ type: 'doc', content: [{ type: 'paragraph', content: [] }] })).toBe(true)
    expect(isBlankBox({ type: 'doc' })).toBe(true)
  })

  it('an empty code block, list or quote is something the user started', () => {
    expect(isBlankBox({ type: 'doc', content: [{ type: 'codeBlock' }] })).toBe(false)
    expect(isBlankBox({ type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] }] })).toBe(false)
    expect(isBlankBox({ type: 'doc', content: [{ type: 'blockquote', content: [{ type: 'paragraph' }] }] })).toBe(false)
    expect(isBlankBox({ type: 'doc', content: [{ type: 'paragraph' }, { type: 'paragraph' }] })).toBe(false)
    expect(isBlankBox({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] })).toBe(false)
  })
})
