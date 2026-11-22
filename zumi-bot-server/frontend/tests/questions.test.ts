import { describe, expect, it } from 'vitest'
import type { Question } from '@zumibot/shared/questions'
import {
  EMPTY_DRAFT,
  answerOf,
  buildAnswers,
  choose,
  chooseOther,
  enterAction,
  goTo,
  questionMarkdown,
  shownAnswer,
  typeOther,
  type Draft
} from '../src/state/questions'

const single: Question = {
  text: 'Which?',
  header: 'H',
  kind: 'choice',
  multiSelect: false,
  options: [
    { label: 'Yes', description: null, preview: null },
    { label: 'No', description: null, preview: null }
  ],
  description: null,
  placeholder: null,
  min: null,
  max: null,
  step: null,
  defaultValue: null,
  unit: null
}

const multi: Question = {
  text: 'Sizes?',
  header: 'H2',
  kind: 'choice',
  multiSelect: true,
  options: [
    { label: 'S', description: null, preview: null },
    { label: 'M', description: null, preview: null }
  ],
  description: null,
  placeholder: null,
  min: null,
  max: null,
  step: null,
  defaultValue: null,
  unit: null
}

const qs: Question[] = [single, multi]

describe('choose', () => {
  it('on a single-select at a non-last step picks and advances', () => {
    const d = choose(EMPTY_DRAFT, qs, 'Yes')
    expect(d.step).toBe(1)
    expect(d.picks['Which?']).toEqual({ labels: ['Yes'], other: null })
  })

  it('on a single-select at the last step picks without advancing', () => {
    // 'Which?' alone is both the first and the last question, so step 0 is the last step.
    const soloQs: Question[] = [single]
    const d = choose(EMPTY_DRAFT, soloQs, 'Yes')
    expect(d.step).toBe(0)
    expect(d.picks['Which?']).toEqual({ labels: ['Yes'], other: null })
  })

  it('on a multi-select toggles labels in option order and never advances', () => {
    let d: Draft = { step: 1, picks: {} }
    d = choose(d, qs, 'M')
    expect(d.step).toBe(1)
    expect(d.picks['Sizes?'].labels).toEqual(['M'])
    d = choose(d, qs, 'S')
    expect(d.step).toBe(1)
    expect(d.picks['Sizes?'].labels).toEqual(['S', 'M'])
    d = choose(d, qs, 'S')
    expect(d.step).toBe(1)
    expect(d.picks['Sizes?'].labels).toEqual(['M'])
  })
})

describe('chooseOther / typeOther on a single-select', () => {
  it('chooseOther clears the picked label, sets other to empty string, and does not advance', () => {
    let d = choose(EMPTY_DRAFT, qs, 'Yes') // step 0 -> advances to 1
    d = { ...d, step: 0 }
    d = chooseOther(d, qs)
    expect(d.step).toBe(0)
    expect(d.picks['Which?']).toEqual({ labels: [], other: '' })
  })

  it('typeOther trims for answerOf, and an all-whitespace value answers null', () => {
    let d: Draft = { step: 0, picks: {} }
    d = chooseOther(d, qs)
    d = typeOther(d, qs, ' blue ')
    expect(answerOf(single, d.picks['Which?'])).toBe('blue')

    d = typeOther(d, qs, '   ')
    expect(answerOf(single, d.picks['Which?'])).toBeNull()
  })
})

describe('answerOf on a multi-select', () => {
  it('appends the Other text after the selected option labels', () => {
    let d: Draft = { step: 1, picks: {} }
    d = choose(d, qs, 'S')
    d = chooseOther(d, qs)
    d = typeOther(d, qs, 'XL')
    expect(answerOf(multi, d.picks['Sizes?'])).toEqual(['S', 'XL'])
  })

  it('is null when nothing is chosen', () => {
    expect(answerOf(multi, undefined)).toBeNull()
    expect(answerOf(multi, { labels: [], other: null })).toBeNull()
  })
})

describe('buildAnswers', () => {
  it('is null when one question is unanswered', () => {
    const d: Draft = { step: 1, picks: { 'Which?': { labels: ['Yes'], other: null } } }
    expect(buildAnswers(qs, d)).toBeNull()
  })

  it('builds an answer keyed by question text once all are answered', () => {
    const d: Draft = {
      step: 1,
      picks: {
        'Which?': { labels: ['Yes'], other: null },
        'Sizes?': { labels: ['S'], other: null }
      }
    }
    expect(buildAnswers(qs, d)).toEqual({ 'Which?': 'Yes', 'Sizes?': ['S'] })
  })
})

describe('enterAction', () => {
  it('sends on the only question once its Other text is typed', () => {
    let d = chooseOther(EMPTY_DRAFT, [single])
    expect(enterAction(d, [single])).toBeNull()
    d = typeOther(d, [single], 'where are you trying?')
    expect(enterAction(d, [single])).toBe('send')
  })

  it('does nothing on blank Other text', () => {
    const d = typeOther(chooseOther(EMPTY_DRAFT, [single]), [single], '   ')
    expect(enterAction(d, [single])).toBeNull()
  })

  it('moves to the next step before the last one', () => {
    const d = typeOther(chooseOther(EMPTY_DRAFT, qs), qs, 'Maybe')
    expect(enterAction(d, qs)).toBe('next')
  })

  it('does nothing on the last step while an earlier question is unanswered', () => {
    const d: Draft = { step: 1, picks: { 'Sizes?': { labels: [], other: 'XL' } } }
    expect(enterAction(d, qs)).toBeNull()
  })

  it('sends on the last step once every question is answered', () => {
    const d: Draft = { step: 1, picks: { 'Which?': { labels: ['Yes'], other: null }, 'Sizes?': { labels: [], other: 'XL' } } }
    expect(enterAction(d, qs)).toBe('send')
  })
})

describe('goTo', () => {
  it('clamps into 0..qs.length-1', () => {
    expect(goTo(EMPTY_DRAFT, qs, 5).step).toBe(1)
    expect(goTo(EMPTY_DRAFT, qs, -1).step).toBe(0)
  })
})

describe('shownAnswer', () => {
  it('matches a sent string against the question options', () => {
    expect(shownAnswer(single, 'Yes')).toEqual({ labels: ['Yes'], other: null })
    expect(shownAnswer(single, 'teal')).toEqual({ labels: [], other: 'teal' })
  })

  it('splits a sent multi-select array into matching labels and leftover Other text', () => {
    expect(shownAnswer(multi, ['S', 'XL'])).toEqual({ labels: ['S'], other: 'XL' })
  })

  it('is empty when there is no stored answer', () => {
    expect(shownAnswer(single, undefined)).toEqual({ labels: [], other: null })
  })
})

describe('questionMarkdown', () => {
  it('ends a list before an unindented plain line, so it is not glued to the last item', () => {
    expect(questionMarkdown('Intro\n1. a\n2. b\nReply "apply" or "stop".')).toBe('Intro\n1. a\n2. b\n\nReply "apply" or "stop".')
    expect(questionMarkdown('- a\nMinor: x\n- b\nDone')).toBe('- a\n\nMinor: x\n- b\n\nDone')
  })

  it('keeps an indented continuation inside its item', () => {
    expect(questionMarkdown('1. a\n   more\nEnd')).toBe('1. a\n   more\n\nEnd')
  })

  it('leaves text without lists, blank-separated lists and fenced code as they are', () => {
    expect(questionMarkdown('One\nTwo')).toBe('One\nTwo')
    expect(questionMarkdown('1. a\n\nAfter')).toBe('1. a\n\nAfter')
    expect(questionMarkdown('```\n- a\nb\n```')).toBe('```\n- a\nb\n```')
  })
})
