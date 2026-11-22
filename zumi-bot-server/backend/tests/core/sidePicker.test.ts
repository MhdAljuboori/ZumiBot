import { expect, test } from 'vitest'
import { fallbackPick, parsePick, pickArgs, pickPrompt, type PickInput } from '../../src/core/btw/sidePicker'
import { runJsonCall } from '../../src/core/chat/moderator'

const input: PickInput = {
  members: [
    { name: 'a', description: 'builds' },
    { name: 'b', description: 'reviews' },
    { name: 'c', description: 'tests' }
  ],
  messages: [
    { from: 'c', text: 'finished tests' },
    { from: null, text: 'thanks' }
  ],
  working: [],
  question: 'How far along is the build?'
}

test('pickArgs asks Haiku for one member without tools, settings, MCP or persistence', () => {
  const args = pickArgs()
  const value = (flag: string) => args[args.indexOf(flag) + 1]
  expect(value('--model')).toBe('haiku')
  expect(value('--tools')).toBe('')
  expect(value('--setting-sources')).toBe('')
  expect(args).toContain('--strict-mcp-config')
  expect(args).toContain('--no-session-persistence')
  expect(value('--output-format')).toBe('json')
  expect(JSON.parse(value('--json-schema'))).toEqual({
    type: 'object',
    properties: { member: { type: 'string' } },
    required: ['member'],
    additionalProperties: false
  })
  expect(value('--system-prompt')).toContain('side question')
  expect(value('--system-prompt')).toContain('preferring the member doing the work')
  expect(value('--system-prompt')).not.toContain('\n')
})

test('pickPrompt lists members, bounded recent messages, working members and the question', () => {
  const messages = Array.from({ length: 25 }, (_, i) => ({ from: null, text: `m${i}-` + 'x'.repeat(2000) }))
  const prompt = pickPrompt({ ...input, members: [{ name: 'ui-ux-specialist', description: 'designs' }], messages, working: ['a', 'b'] })
  expect(prompt).toContain('- @ui-ux-specialist (Ui Ux Specialist): designs')
  expect(prompt).not.toContain('m4-')
  expect(prompt).toContain(`<message from="user">m5-${'x'.repeat(1497)}</message>`)
  expect(prompt).toContain('m24-')
  expect(prompt).not.toContain('x'.repeat(1501))
  expect(prompt).toContain('Working now: @a, @b')
  expect(prompt.endsWith(input.question)).toBe(true)
  expect(pickPrompt(input)).toContain('Working now: nobody')
})

test('pickPrompt includes attachment names as the moderator does', () => {
  const attachment = { id: 'f', name: 'build.log', mime: 'text/plain', size: 1, kind: 'file' as const }
  expect(pickPrompt({ ...input, messages: [{ from: 'a', text: 'look', attachments: [attachment] }] })).toContain(
    '<message from="a">look [attached: build.log]</message>'
  )
})

test('parsePick accepts a member in bare, structured and result JSON', () => {
  expect(parsePick('{"member":"a"}', ['a', 'b'])).toBe('a')
  expect(parsePick('{"structured_output":{"member":"b"}}', ['a', 'b'])).toBe('b')
  expect(parsePick('{"result":"{\\"member\\":\\"a\\"}"}', ['a', 'b'])).toBe('a')
  expect(parsePick('{"structured_output":{"member":" @UI-UX-Specialist "}}', ['ui-ux-specialist'])).toBe('ui-ux-specialist')
})

test('parsePick rejects unknown members, errors and malformed output', () => {
  for (const out of [
    '{"member":"zz"}',
    'garbage',
    'null',
    '[]',
    '{"member":1}',
    '{"is_error":true,"member":"a"}',
    '{"structured_output":{"member":[]}}',
    '{"result":"null"}'
  ]) {
    expect(parsePick(out, ['a', 'b'])).toBeNull()
  }
})

test('fallbackPick prefers the single working member', () => {
  expect(fallbackPick({ ...input, working: ['b'] })).toBe('b')
})

test('fallbackPick uses the last member who spoke when multiple or no members work', () => {
  expect(fallbackPick({ ...input, working: ['a', 'b'] })).toBe('c')
  expect(fallbackPick(input)).toBe('c')
})

test('fallbackPick uses the first member when no member has spoken', () => {
  expect(fallbackPick({ ...input, messages: [{ from: null, text: 'hello' }] })).toBe('a')
  expect(fallbackPick({ ...input, messages: [] })).toBe('a')
})

test('runJsonCall passes supplied args, stdin, cwd and environment to the JSON subprocess', async () => {
  const script =
    "let stdin = ''; process.stdin.on('data', d => stdin += d); process.stdin.on('end', () => process.stdout.write(JSON.stringify({member: process.env.PICK_MEMBER, stdin, cwd: process.cwd(), arg: process.argv[1]})))"
  const result = await runJsonCall({
    bin: process.execPath,
    cwd: process.cwd(),
    env: { ...process.env, PICK_MEMBER: 'b' },
    args: ['-e', script, 'custom-arg'],
    stdin: pickPrompt(input),
    signal: new AbortController().signal,
    parse: (stdout) => JSON.parse(stdout) as { member: string; stdin: string; cwd: string; arg: string }
  })
  expect(result).toEqual({ member: 'b', stdin: pickPrompt(input), cwd: process.cwd(), arg: 'custom-arg' })
})

test('runJsonCall reports cost even when the subprocess exits with an error', async () => {
  const out = {
    uuid: 'pick-cost',
    total_cost_usd: 0.01,
    modelUsage: { haiku: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, costUSD: 0.01 } }
  }
  const calls: unknown[][] = []
  const result = await runJsonCall({
    bin: process.execPath,
    cwd: process.cwd(),
    args: [
      '-e',
      `process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(${JSON.stringify(JSON.stringify(out))}); process.exitCode = 1 })`
    ],
    stdin: 'question',
    signal: new AbortController().signal,
    parse: () => 'unexpected',
    onCost: (cost, id) => calls.push([cost, id])
  })
  expect(result).toBeNull()
  expect(calls).toEqual([
    [{ totalUsd: 0.01, models: { haiku: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costUsd: 0.01 } } }, 'pick-cost']
  ])
})
