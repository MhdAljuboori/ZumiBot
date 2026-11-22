import { expect, test } from 'vitest'
import { ACK_MAX_CHARS, ACK_MESSAGE_CHARS, ackArgs, ackMessage, ackPrompt, parseAck } from '../../src/core/chat/acknowledge'

const input = { agent: 'daily-digest', description: 'Builds the daily digest.', message: 'Build my day', todos: false }

test('runs on haiku with no tools, settings or session', () => {
  const args = ackArgs()
  expect(args.slice(0, 3)).toEqual(['-p', '--model', 'haiku'])
  expect(args).toContain('--no-session-persistence')
  expect(args[args.indexOf('--tools') + 1]).toBe('')
})

test('the prompt names the agent, its role, the to-do state and the message', () => {
  const p = ackPrompt(input)
  expect(p).toContain('Assistant: Daily Digest')
  expect(p).toContain('Role: Builds the daily digest.')
  expect(p).toContain('To-dos: off')
  expect(p).toContain('<message>Build my day</message>')
  expect(ackPrompt({ ...input, todos: true })).toContain('To-dos: on')
  const long = ackPrompt({ ...input, message: 'x'.repeat(ACK_MESSAGE_CHARS + 50) })
  expect(long).toContain('x'.repeat(ACK_MESSAGE_CHARS) + '…</message>')
})

test('reads the line from structured output, or from a JSON result', () => {
  expect(parseAck(JSON.stringify({ structured_output: { text: '  Checking all channels\nnow. ' } }))).toBe('Checking all channels now.')
  expect(parseAck(JSON.stringify({ result: JSON.stringify({ text: 'On it.' }) }))).toBe('On it.')
})

test('anything but one usable line is null', () => {
  expect(parseAck('not json')).toBeNull()
  expect(parseAck(JSON.stringify({ is_error: true, structured_output: { text: 'x' } }))).toBeNull()
  expect(parseAck(JSON.stringify({ structured_output: { text: '   ' } }))).toBeNull()
  expect(parseAck(JSON.stringify({ structured_output: { text: 'x'.repeat(ACK_MAX_CHARS + 1) } }))).toBeNull()
  expect(parseAck(JSON.stringify({ result: 'plain text' }))).toBeNull()
})

test("the message is a command's filled prompt, else the text, else the attachments' names", () => {
  const base = { type: 'user' as const, id: 'u', ts: 0 }
  expect(ackMessage({ ...base, text: '/my-day', command: { agent: 'a', name: 'my-day', prompt: 'Build my daily digest' } })).toBe(
    'Build my daily digest'
  )
  expect(ackMessage({ ...base, text: 'hello' })).toBe('hello')
  expect(ackMessage({ ...base, text: '', attachments: [{ id: '1', name: 'a.png', mime: 'image/png', size: 1 }] as never })).toBe(
    '[attached: a.png]'
  )
  expect(ackMessage({ ...base, text: ' ' })).toBe('')
})
