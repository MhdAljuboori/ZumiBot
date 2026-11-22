import { expect, test } from 'vitest'
import {
  agentAllowKey,
  allowKey,
  allowResponse,
  denyResponse,
  encodeUserMessage,
  errorResponse,
  parseDecision,
  planSentBack,
  ruleOf
} from '../../src/core/chat/controlProtocol'

test('encodeUserMessage round-trips', () => {
  const inputs = ['', 'hi', 'a "q" \\ b', 'l1\nl2', 'x y', 'emoji \u{1F600}', 'مرحبا', 'lone \ud83d surrogate']
  for (const s of inputs) {
    const enc = encodeUserMessage(s)
    expect(JSON.parse(enc)).toEqual({ type: 'user', message: { role: 'user', content: s } })
    expect(enc.endsWith('\n')).toBe(true)
    expect(enc.slice(0, -1)).not.toContain('\n')
  }
})

test('allow/deny/error responses have the exact wire shapes', () => {
  const input = { command: 'ls', n: [1, { a: 2 }] }
  expect(allowResponse('r1', input)).toEqual({
    type: 'control_response',
    response: { subtype: 'success', request_id: 'r1', response: { behavior: 'allow', updatedInput: { command: 'ls', n: [1, { a: 2 }] } } }
  })
  // The shape the plan probe proved: the CLI goes on in this mode instead of `default`.
  expect(allowResponse('r1', input, [{ type: 'setMode', mode: 'auto', destination: 'session' }])).toEqual({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'r1',
      response: { behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'setMode', mode: 'auto', destination: 'session' }] }
    }
  })
  expect(denyResponse('r2', 'Denied by the user')).toEqual({
    type: 'control_response',
    response: { subtype: 'success', request_id: 'r2', response: { behavior: 'deny', message: 'Denied by the user' } }
  })
  expect(errorResponse('r3', 'boom')).toEqual({
    type: 'control_response',
    response: { subtype: 'error', request_id: 'r3', error: 'boom' }
  })
})

test('allowKey: Bash by command, mcp by tool name, others by stable input', () => {
  expect(allowKey('Bash', { command: 'a' })).not.toBe(allowKey('Bash', { command: 'b' }))
  expect(allowKey('Bash', { command: 'a', description: 'x' })).toBe(allowKey('Bash', { command: 'a', description: 'y' }))
  expect(allowKey('mcp__s__t', { x: 1 })).toBe(allowKey('mcp__s__t', { y: 2 }))
  expect(allowKey('Read', { a: 1, b: { c: 2, d: 3 } })).toBe(allowKey('Read', { b: { d: 3, c: 2 }, a: 1 }))
  expect(allowKey('Read', { a: 1 })).not.toBe(allowKey('Write', { a: 1 }))
  expect(allowKey('mcp__s__t', {})).not.toBe(allowKey('mcp__s__u', {}))
})

test('parseDecision', () => {
  for (const v of ['allow-once', 'allow-chat', 'deny'] as const) expect(parseDecision(v)).toBe(v)
  for (const v of ['allow', undefined, 5])
    expect(() => parseDecision(v)).toThrow(new TypeError('decision must be allow-once, allow-chat, allow-agent, allow-step or deny'))
})

test('planSentBack tells the agent to stay in plan mode, with the feedback when there is one', () => {
  expect(planSentBack('add tests')).toBe(
    'The user did not approve the plan yet. Stay in plan mode, revise the plan based on their feedback, then call ExitPlanMode again.\n\nFeedback: add tests'
  )
  expect(planSentBack(null)).toBe(
    'The user did not approve the plan yet. Stay in plan mode, and end your reply so the user can say what to change.'
  )
})

test('encodeUserMessage keeps a block list', () => {
  const img = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'QUJD' } }
  const content = [{ type: 'text' as const, text: 'hi' }, img]
  const enc = encodeUserMessage(content)
  expect(enc.endsWith('\n')).toBe(true)
  expect(enc.slice(0, -1)).not.toContain('\n')
  expect(JSON.parse(enc).message.content).toEqual(content)
})

test('agentAllowKey matches any tool by name, Bash by exact command', () => {
  expect(agentAllowKey('WebSearch', { query: 'a' })).toBe(agentAllowKey('WebSearch', { query: 'b' }))
  expect(agentAllowKey('mcp__mail__send', { to: 'x' })).toBe(agentAllowKey('mcp__mail__send', {}))
  expect(agentAllowKey('Bash', { command: 'ls' })).not.toBe(agentAllowKey('Bash', { command: 'ls -la' }))
  expect(agentAllowKey('Bash', { command: 'ls' })).toBe(agentAllowKey('Bash', { command: 'ls', description: 'x' }))
})
test('agentAllowKey keys an unsandboxed Bash call apart from the sandboxed one', () => {
  const sandboxed = agentAllowKey('Bash', { command: 'rm -rf build' })
  const unsandboxed = agentAllowKey('Bash', { command: 'rm -rf build', dangerouslyDisableSandbox: true })
  // A rule remembered for one never answers the other, in either direction.
  expect(unsandboxed).not.toBe(sandboxed)
  expect(ruleOf('Bash', { command: 'rm -rf build', dangerouslyDisableSandbox: true }).key).toBe(unsandboxed)
  expect(ruleOf('Bash', { command: 'rm -rf build' }).key).toBe(sandboxed)
  expect(agentAllowKey('Bash', { command: 'rm -rf build', dangerouslyDisableSandbox: false })).toBe(sandboxed)
  // "Allow for this chat" is left as it was.
  expect(allowKey('Bash', { command: 'rm -rf build', dangerouslyDisableSandbox: true })).toBe(allowKey('Bash', { command: 'rm -rf build' }))
})
test('ruleOf keeps the Bash command only', () => {
  expect(ruleOf('Bash', { command: 'date' })).toEqual({
    key: agentAllowKey('Bash', { command: 'date' }),
    toolName: 'Bash',
    command: 'date'
  })
  expect(ruleOf('WebFetch', { url: 'u' })).toEqual({ key: agentAllowKey('WebFetch', {}), toolName: 'WebFetch', command: null })
})
test('parseDecision accepts allow-agent', () => expect(parseDecision('allow-agent')).toBe('allow-agent'))
test('parseDecision accepts allow-step', () => expect(parseDecision('allow-step')).toBe('allow-step'))

test('a process start is kept per exact command and folder, never by tool name alone, and never equals a Bash key', () => {
  const start = 'mcp__zumibot_processes__start'
  const dev = { command: 'npm run dev', cwd: 'web', name: 'web' }
  for (const key of [allowKey, agentAllowKey]) {
    expect(key(start, dev)).toBe(key(start, { ...dev, name: 'other' }))
    expect(key(start, dev)).not.toBe(key(start, { ...dev, command: 'npm run build' }))
    expect(key(start, dev)).not.toBe(key(start, { ...dev, cwd: 'api' }))
    expect(key(start, dev)).not.toBe(key('Bash', { command: 'npm run dev' }))
  }
  expect(allowKey('mcp__zumibot_processes__logs', { id: 'p_0123456789' })).toBe(JSON.stringify(['mcp__zumibot_processes__logs']))
  expect(ruleOf(start, dev)).toMatchObject({ toolName: start, command: 'npm run dev' })
})
