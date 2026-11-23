import { describe, expect, it } from 'vitest'
import { parseRoute, routeArgs, routePrompt, ROUTE_MESSAGE_MAX } from '../../src/core/todos/commentRouting'

const answer = (asks: unknown): string => JSON.stringify({ is_error: false, structured_output: { asks } })
const names = ['work-assistant', 'workiom-master']

describe('parseRoute', () => {
  it('keeps the addressed candidates with their messages, in order, matching handles in any case and with an @', () => {
    expect(
      parseRoute(
        answer([
          { agent: '@Work-Assistant', message: ' Ask @workiom-master to check whether we have a card for this. ' },
          { agent: 'workiom-master', message: 'Check whether we have a card.' }
        ]),
        names
      )
    ).toEqual([
      { agent: 'work-assistant', message: 'Ask @workiom-master to check whether we have a card for this.' },
      { agent: 'workiom-master', message: 'Check whether we have a card.' }
    ])
  })

  it('reads the answer from `result` when the CLI gave no structured output', () => {
    const stdout = JSON.stringify({ is_error: false, result: JSON.stringify({ asks: [{ agent: 'work-assistant', message: 'Hi.' }] }) })
    expect(parseRoute(stdout, names)).toEqual([{ agent: 'work-assistant', message: 'Hi.' }])
  })

  it('answers an empty list when nobody is addressed', () => {
    expect(parseRoute(answer([]), names)).toEqual([])
  })

  it('leaves out an agent that is no candidate, a repeat, and an empty or overlong message', () => {
    const long = 'x'.repeat(ROUTE_MESSAGE_MAX + 1)
    expect(
      parseRoute(
        answer([
          { agent: 'someone-else', message: 'Do it.' },
          { agent: 'work-assistant', message: '   ' },
          { agent: 'workiom-master', message: long },
          { agent: 'work-assistant', message: 'First.' },
          { agent: 'work-assistant', message: 'Again.' },
          { agent: 3, message: 'No.' }
        ]),
        names
      )
    ).toEqual([{ agent: 'work-assistant', message: 'First.' }])
  })

  it('gives null for anything that is not a usable answer, so every candidate is asked as before', () => {
    expect(parseRoute('not json', names)).toBeNull()
    expect(parseRoute('{"type":"assistant"}\n{"type":"result"}', names)).toBeNull()
    expect(parseRoute(JSON.stringify({ is_error: true, structured_output: { asks: [] } }), names)).toBeNull()
    expect(parseRoute(JSON.stringify({ is_error: false, structured_output: { asks: 'no' } }), names)).toBeNull()
  })
})

describe('routePrompt', () => {
  it('names the card, each candidate with its role, the thread start for a reply, and the comment as material', () => {
    const p = routePrompt({
      card: 'Mila pricing',
      comment: '@work-assistant Can you ask @workiom-master to check if we have a card for this?',
      thread: 'Earlier question',
      candidates: [
        { name: 'work-assistant', description: 'Personal work assistant.' },
        { name: 'workiom-master', description: '' }
      ]
    })
    expect(p).toContain('Card: Mila pricing')
    expect(p).toContain('- @work-assistant (Work Assistant): Personal work assistant.')
    expect(p).toContain('- @workiom-master (Workiom Master): (no description)')
    expect(p).toContain('<thread_start>Earlier question</thread_start>')
    expect(p).toContain('<comment>@work-assistant Can you ask @workiom-master to check if we have a card for this?</comment>')
  })

  it('leaves the thread out of a top-level comment', () => {
    expect(routePrompt({ card: 'C', comment: 'hi', thread: null, candidates: [] })).not.toContain('thread_start')
  })
})

describe('routeArgs', () => {
  it('runs Haiku once with no tools, no settings and no session, answering to the schema', () => {
    const args = routeArgs()
    expect(args.slice(0, 3)).toEqual(['-p', '--model', 'haiku'])
    expect(args).toContain('--no-session-persistence')
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(JSON.parse(args[args.indexOf('--json-schema') + 1]!).required).toEqual(['asks'])
  })
})
