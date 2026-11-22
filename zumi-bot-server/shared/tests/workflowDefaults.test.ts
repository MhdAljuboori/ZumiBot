import { describe, expect, it } from 'vitest'
import { stepDefaults } from '@zumibot/shared/workflowDefaults'

describe('stepDefaults', () => {
  it('matches the canvas defaults', () => {
    expect(stepDefaults('llm')).toEqual({ model: 'haiku', effort: 'low', prompt: '' })
    expect(stepDefaults('condition')).toEqual({ model: 'haiku', question: '' })
    expect(stepDefaults('approval')).toEqual({ question: 'Approve?', editable: true })
    expect(stepDefaults('wait')).toEqual({ minutes: 5 })
    expect(stepDefaults('notify')).toEqual({ title: '' })
    expect(stepDefaults('agent')).toEqual({ agent: '', prompt: '', cwd: '' })
    expect(stepDefaults('room')).toEqual({ room: '', prompt: '{{input}}' })
    expect(stepDefaults('chat')).toEqual({ chat: '', prompt: '{{input}}' })
    expect(stepDefaults('foreach')).toEqual({ agent: '', prompt: '', cwd: '' })
  })
  it('gives a fresh object each call', () => {
    expect(stepDefaults('wait')).not.toBe(stepDefaults('wait'))
  })
})
