import { describe, expect, it } from 'vitest'
import {
  answersOf,
  approvalCardHtml,
  cutForCard,
  optionLabel,
  outcomeLine,
  questionHtml,
  typedAnswerProblem
} from '@zumibot/shared/channelCards'
import type { Question } from '@zumibot/shared/questions'

const q = (o: Partial<Question>): Question => ({
  text: 'Q?',
  header: '',
  kind: 'choice',
  multiSelect: false,
  options: [],
  description: null,
  placeholder: null,
  min: null,
  max: null,
  step: null,
  defaultValue: null,
  unit: null,
  ...o
})

describe('approvalCardHtml', () => {
  it('shows a Bash command whole and escaped, with its description', () => {
    const html = approvalCardHtml({
      agent: 'code-reviewer',
      toolName: 'Bash',
      input: { command: 'echo "<b>" && rm x', description: 'Tidy <up>' },
      summary: 'Bash(echo)',
      description: null,
      reason: 'Outside the folder'
    })
    expect(html).toBe(
      'Code Reviewer wants to use <b>Bash</b>\n<pre>echo "&lt;b&gt;" &amp;&amp; rm x</pre>\nTidy &lt;up&gt;\n<i>Outside the folder</i>'
    )
  })

  it('shows another tool by its summary', () => {
    expect(
      approvalCardHtml({
        agent: null,
        toolName: 'Write',
        input: { file_path: '/a/b' },
        summary: 'Write /a/b',
        description: null,
        reason: null
      })
    ).toBe('The agent wants to use <b>Write</b>\n<code>Write /a/b</code>')
  })

  it('cuts a long command on a line and says so', () => {
    const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
    const out = cutForCard(long, 100)
    expect(out.endsWith('… (cut, see ZumiBot)')).toBe(true)
    expect(
      out
        .split('\n')
        .slice(0, -1)
        .every((l) => /^line \d+$/.test(l))
    ).toBe(true)
  })
})

describe('question cards', () => {
  it('lists options with descriptions and says how to answer', () => {
    expect(
      questionHtml(q({ header: 'Color', options: [{ label: 'Red', description: 'warm', preview: null }] }), {
        heading: 'A question for you',
        index: 0,
        count: 2
      })
    ).toBe('<b>A question for you</b>\n1/2 Color: Q?\n• <b>Red</b> — warm')
    expect(questionHtml(q({ kind: 'number' }), { heading: null, index: 0, count: 1 })).toBe('Q?\nReply to this message with a number.')
    expect(
      questionHtml(q({ multiSelect: true, options: [{ label: 'A', description: null, preview: null }] }), {
        heading: null,
        index: 0,
        count: 1
      })
    ).toContain('Pick any, then Done.')
  })

  it('builds the answers only once every question has one', () => {
    const qs = [q({ text: 'a' }), q({ text: 'b', multiSelect: true })]
    expect(answersOf(qs, new Map([[0, 'x']]))).toBeNull()
    expect(
      answersOf(
        qs,
        new Map<number, string | string[]>([
          [0, 'x'],
          [1, []]
        ])
      )
    ).toBeNull()
    expect(
      answersOf(
        qs,
        new Map<number, string | string[]>([
          [0, 'x'],
          [1, ['y', 'z']]
        ])
      )
    ).toEqual({ a: 'x', b: ['y', 'z'] })
  })

  it('checks typed answers', () => {
    expect(typedAnswerProblem(q({ kind: 'text' }), '  ')).toBe('That answer is empty.')
    expect(typedAnswerProblem(q({ kind: 'number', min: 1, max: 5 }), 'seven')).toBe('That question wants a number.')
    expect(typedAnswerProblem(q({ kind: 'number', min: 1, max: 5 }), '9')).toBe('The largest allowed is 5.')
    expect(typedAnswerProblem(q({ kind: 'number', min: 1, max: 5 }), '3')).toBeNull()
  })

  it('cuts long labels and ticks picked ones', () => {
    expect(optionLabel('x'.repeat(50), false)).toHaveLength(40)
    expect(optionLabel('M', true)).toBe('✓ M')
  })
})

describe('outcomeLine', () => {
  it('says what happened and where', () => {
    expect(outcomeLine('allowed-once', true)).toBe('✓ Allowed once')
    expect(outcomeLine('denied', false)).toBe('✗ Denied in ZumiBot')
    expect(outcomeLine('allowed-agent', false)).toBe('✓ Allowed in ZumiBot')
    expect(outcomeLine('sent-back', true)).toBe('↩ Sent back to keep planning')
    expect(outcomeLine('unanswered', false)).toBe('No longer pending')
  })
})
