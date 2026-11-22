import { describe, expect, it } from 'vitest'
import { findMentions, mentionsEveryone, splitMentions, stripMentions } from '@zumibot/shared/mentions'

const M = ['workiom5-assistance', 'ui-ux-specialist']

describe('mentions', () => {
  it('finds mentions in order, once each, case-insensitively', () => {
    expect(findMentions('@UI-UX-Specialist and @workiom5-assistance, then @ui-ux-specialist', M)).toEqual([
      'ui-ux-specialist',
      'workiom5-assistance'
    ])
  })
  it('stops handles at punctuation', () => {
    expect(findMentions('(@ui-ux-specialist). @workiom5-assistance!', M)).toEqual(['ui-ux-specialist', 'workiom5-assistance'])
  })
  it('ignores code, emails and non-members', () => {
    expect(findMentions('`@ui-ux-specialist`\n```\n@workiom5-assistance\n```\nmail a@ui-ux-specialist @someone', M)).toEqual([])
  })
  it('splits text and mentions', () => {
    expect(splitMentions('hi @ui-ux-specialist!', M)).toEqual([
      { kind: 'text', text: 'hi ' },
      { kind: 'mention', name: 'ui-ux-specialist', raw: '@ui-ux-specialist' },
      { kind: 'text', text: '!' }
    ])
  })
  it('strips mentions for titles', () => {
    expect(stripMentions('@workiom5-assistance @ui-ux-specialist  fix the toggles', M)).toBe('fix the toggles')
  })

  it('findMentions ignores @everyone, even for a member named everyone', () => {
    expect(findMentions('@everyone hi @ui-ux-specialist', M)).toEqual(['ui-ux-specialist'])
    expect(findMentions('@everyone hi', [...M, 'everyone'])).toEqual([])
  })
  it('mentionsEveryone follows the mention boundary rules and skips code', () => {
    expect(mentionsEveryone('@everyone hi')).toBe(true)
    expect(mentionsEveryone('hey @Everyone')).toBe(true)
    expect(mentionsEveryone('`@everyone`')).toBe(false)
    expect(mentionsEveryone('```\n@everyone\n```')).toBe(false)
    expect(mentionsEveryone('a@everyone.com')).toBe(false)
    expect(mentionsEveryone('@everyones')).toBe(false)
  })
  it('splitMentions makes an everyone segment only when asked', () => {
    expect(splitMentions('hi @Everyone!', M, true)).toEqual([
      { kind: 'text', text: 'hi ' },
      { kind: 'mention', name: 'everyone', raw: '@Everyone' },
      { kind: 'text', text: '!' }
    ])
    expect(splitMentions('hi @everyone!', M)).toEqual([{ kind: 'text', text: 'hi @everyone!' }])
  })
  it('stripMentions drops @everyone', () => {
    expect(stripMentions('@everyone  fix the toggles', M)).toBe('fix the toggles')
  })
})
