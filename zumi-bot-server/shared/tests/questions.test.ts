import { describe, expect, it } from 'vitest'
import { checkAnswers, parseQuestions, questionHeading } from '@zumibot/shared/questions'

const input = {
  questions: [
    {
      question: 'Which text?',
      header: 'Mila key',
      options: [
        { label: 'Master', description: 'short' },
        { label: 'w5', description: 'long', preview: 'x' }
      ],
      multiSelect: false
    },
    {
      question: 'Which sizes?',
      header: 'Sizes',
      options: [
        { label: 'S', description: '' },
        { label: 'M', description: '' }
      ],
      multiSelect: true
    }
  ]
}
it('parses questions with defaults', () => {
  const p = parseQuestions(input)!
  expect(p.title).toBeNull()
  expect(p.questions.map((q) => [q.text, q.kind, q.multiSelect, q.options.length])).toEqual([
    ['Which text?', 'choice', false, 2],
    ['Which sizes?', 'choice', true, 2]
  ])
  expect(p.questions[0].options[1]).toEqual({ label: 'w5', description: 'long', preview: 'x' })
})
it('reads the extended kinds', () => {
  const p = parseQuestions({
    title: 'T',
    questions: [
      { question: 'Name?', header: 'N', kind: 'text', placeholder: 'type' },
      { question: 'How many?', header: 'C', kind: 'number', min: 1, max: 5, unit: 'px' }
    ]
  })!
  expect(p.title).toBe('T')
  expect(p.questions.map((q) => [q.kind, q.options.length, q.placeholder, q.min, q.max, q.unit])).toEqual([
    ['text', 0, 'type', null, null, null],
    ['number', 0, null, 1, 5, 'px']
  ])
})
it.each([
  [{}],
  [null],
  [{ questions: [] }],
  [{ questions: [{ header: 'h' }] }],
  [{ questions: [{ question: 'a?' }, { question: 'a?' }] }],
  [{ questions: [{ question: 'a?', kind: 'slider' }] }]
])('malformed input %j parses to null', (bad) => expect(parseQuestions(bad)).toBeNull())
it('accepts a full, valid answer set', () => {
  expect(checkAnswers(input, { 'Which text?': 'Master', 'Which sizes?': ['S', 'my own'] })).toEqual({
    'Which text?': 'Master',
    'Which sizes?': ['S', 'my own']
  })
})
it.each([
  ['not an object', ['x']],
  ['a missing question', { 'Which text?': 'Master' }],
  ['an unknown question', { 'Which text?': 'Master', 'Which sizes?': ['S'], 'Other?': 'x' }],
  ['a blank answer', { 'Which text?': '  ', 'Which sizes?': ['S'] }],
  ['a list for a single-select question', { 'Which text?': ['Master'], 'Which sizes?': ['S'] }],
  ['an empty list', { 'Which text?': 'Master', 'Which sizes?': [] }],
  ['too many choices', { 'Which text?': 'Master', 'Which sizes?': ['S', 'M', 'a', 'b'] }],
  ['an answer over 8192 chars', { 'Which text?': 'x'.repeat(8193), 'Which sizes?': ['S'] }]
])('rejects %s', (_name, answers) => expect(() => checkAnswers(input, answers)).toThrow(TypeError))
it('rejects input that already carries answers, or malformed input', () => {
  expect(() => checkAnswers({ ...input, answers: {} }, { 'Which text?': 'Master', 'Which sizes?': ['S'] })).toThrow(TypeError)
  expect(() => checkAnswers({}, {})).toThrow(TypeError)
})
describe('questionHeading', () => {
  it('uses the title when there is one, whatever the agent or count', () => {
    expect(questionHeading('Pick a color', 3, null)).toBe('Pick a color')
    expect(questionHeading('Pick a color', 3, 'writer')).toBe('Pick a color')
  })
  it('names the agent and the count for a group card, singular and plural', () => {
    expect(questionHeading(null, 1, 'ui-ux')).toBe('Ui Ux asked 1 question')
    expect(questionHeading(null, 3, 'ui-ux')).toBe('Ui Ux asked 3 questions')
  })
  it('reads "A question for you" for one, and "<n> questions for you" otherwise, in a single chat', () => {
    expect(questionHeading(null, 1, null)).toBe('A question for you')
    expect(questionHeading(null, 3, null)).toBe('3 questions for you')
  })
})
it('accepts a total right at 32768 chars, and rejects one char over', () => {
  // Four single-value questions at the 8192 per-answer cap sum to exactly 32768: the inclusive boundary.
  const four = { questions: Array.from({ length: 4 }, (_, i) => ({ question: `Q${i}?`, header: 'H', kind: 'text' })) }
  const atCap = Object.fromEntries(four.questions.map((q) => [q.question, 'x'.repeat(8192)]))
  expect(checkAnswers(four, atCap)).toEqual(atCap)
  // A fifth question's single extra char pushes the total to 32769, one over the cap.
  const five = { questions: [...four.questions, { question: 'Q4?', header: 'H', kind: 'text' }] }
  expect(() => checkAnswers(five, { ...atCap, 'Q4?': 'x' })).toThrow(TypeError)
})
