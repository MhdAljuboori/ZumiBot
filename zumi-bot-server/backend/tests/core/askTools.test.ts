import { expect, it } from 'vitest'
import { ASK_MESSAGE_MAX, ASK_SIDE_QUESTION_MAX } from '@zumibot/shared/agentAsk'
import { askTools, parseAskCall, parseAskWire, parseSideCall, parseSideWire } from '../../src/core/asks/askTools'

it('parses an ask call and keeps the handle as typed', () => {
  expect(parseAskCall('ask', { agent: '@B', message: 'hi' })).toEqual({ agent: '@B', message: 'hi' })
  expect(parseAskWire({ agent: 'b', message: 'hi' })).toEqual({ agent: 'b', message: 'hi' })
})

it('refuses unknown keys, a wrong tool, an empty or over-long message', () => {
  expect(() => parseAskCall('ask', { agent: 'b', message: 'hi', chatId: 'c' })).toThrow('Invalid ask call')
  expect(() => parseAskCall('other', { agent: 'b', message: 'hi' })).toThrow('Invalid ask call')
  expect(() => parseAskCall('ask', { agent: 'b', message: '   ' })).toThrow('Invalid ask call')
  expect(() => parseAskCall('ask', { agent: '', message: 'hi' })).toThrow('Invalid ask call')
  expect(() => parseAskCall('ask', { agent: 'b' })).toThrow('Invalid ask call')
  expect(() => parseAskCall('ask', null)).toThrow('Invalid ask call')
  expect(() => parseAskCall('ask', { agent: 'b', message: 'x'.repeat(ASK_MESSAGE_MAX + 1) })).toThrow(
    'Invalid ask call: message is longer than 20000 characters'
  )
  expect(parseAskCall('ask', { agent: 'b', message: 'x'.repeat(ASK_MESSAGE_MAX) }).message).toHaveLength(ASK_MESSAGE_MAX)
  expect(() => parseAskWire(undefined)).toThrow('Invalid ask call')
})

it('defines both tools with closed, capped schemas', () => {
  expect(askTools.map((t) => t.name)).toEqual(['ask', 'side_question'])
  expect(askTools[1]).toMatchObject({
    name: 'side_question',
    inputSchema: {
      required: ['agent', 'question'],
      additionalProperties: false,
      properties: { question: { maxLength: ASK_SIDE_QUESTION_MAX } }
    }
  })
  expect(askTools[0]).toMatchObject({
    name: 'ask',
    inputSchema: { required: ['agent', 'message'], additionalProperties: false, properties: { message: { maxLength: ASK_MESSAGE_MAX } } }
  })
})

it('parses a side call and keeps the handle as typed', () => {
  expect(parseSideCall('side_question', { agent: '@b', question: 'q' })).toEqual({ agent: '@b', question: 'q' })
  expect(parseSideWire({ agent: 'b', question: 'q' })).toEqual({ agent: 'b', question: 'q' })
})

it('refuses a side call with unknown keys, an empty or over-long question, or the wrong tool', () => {
  expect(() => parseSideCall('side_question', { agent: 'b', question: 'q', chatId: 'c' })).toThrow(
    'Invalid ask call: side_question takes agent and question only'
  )
  expect(() => parseSideCall('side_question', { agent: 'b', question: '  ' })).toThrow('Invalid ask call')
  expect(() => parseSideCall('side_question', { agent: '', question: 'q' })).toThrow('Invalid ask call')
  expect(() => parseSideCall('side_question', { agent: 'b', question: 'x'.repeat(ASK_SIDE_QUESTION_MAX + 1) })).toThrow(
    'Invalid ask call: question is longer than 4000 characters'
  )
  expect(parseSideCall('side_question', { agent: 'b', question: 'x'.repeat(ASK_SIDE_QUESTION_MAX) }).question).toHaveLength(
    ASK_SIDE_QUESTION_MAX
  )
  expect(() => parseSideCall('ask', { agent: 'b', question: 'q' })).toThrow('Invalid ask call')
  expect(() => parseSideCall('side_question', null)).toThrow('Invalid ask call')
  // The two tools are not interchangeable.
  expect(() => parseAskCall('side_question', { agent: 'b', message: 'hi' })).toThrow('Invalid ask call')
  expect(() => parseSideCall('side_question', { agent: 'b', message: 'hi' })).toThrow('Invalid ask call')
})
