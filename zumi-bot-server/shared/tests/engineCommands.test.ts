import { describe, expect, it } from 'vitest'
import { CLAUDE_DENIED, codexPrompt, engineLeading } from '@zumibot/shared/engineCommands'

describe('engineLeading', () => {
  it('reads a namespaced leading command and trims args', () =>
    expect(engineLeading('/superpowers:brainstorming  fix the menu ')).toEqual({ name: 'superpowers:brainstorming', args: 'fix the menu' }))
  it('takes a bare command', () => expect(engineLeading('/goal')).toEqual({ name: 'goal', args: '' }))
  it.each([' /goal', '/', '//goal', 'hi /goal'])('ignores %j', (t) => expect(engineLeading(t)).toBeNull())
})

describe('codexPrompt', () => {
  it('fills a skill prompt with no args', () => expect(codexPrompt('pdf', '')).toBe('$pdf'))
  it('fills a skill prompt with args', () => expect(codexPrompt('pdf', 'read a.pdf')).toBe('$pdf read a.pdf'))
})

describe('CLAUDE_DENIED', () => {
  it('denies screens and settings', () => {
    for (const n of ['model', 'effort', 'usage', 'login', 'clear', 'compact', 'context']) expect(CLAUDE_DENIED.has(n)).toBe(true)
  })
  it('keeps action built-ins', () => {
    for (const n of ['goal', 'advisor', 'ultrareview', 'security-review', 'init']) expect(CLAUDE_DENIED.has(n)).toBe(false)
  })
})
