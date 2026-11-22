import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { scriptBin } from '../support/chatFakeBin'
import {
  MODERATOR_MESSAGE_CHARS,
  MODERATOR_MESSAGES,
  MODERATOR_NOTE_CHARS,
  moderatorArgs,
  moderatorPrompt,
  parseModeratorOutput,
  runModerator,
  type ModeratorInput
} from '../../src/core/chat/moderator'
import { MATERIAL_RULE } from '@zumibot/shared/workflowTemplate'

const fake = scriptBin(fileURLToPath(new URL('../fixtures/fake-moderator.mjs', import.meta.url)))
const members = ['ui-ux-specialist', 'workiom5-assistance']
const input: ModeratorInput = {
  members: [
    { name: 'ui-ux-specialist', description: 'ui' },
    { name: 'workiom5-assistance', description: 'w5' }
  ],
  messages: [{ from: null, text: 'hi' }],
  speaker: null,
  role: '',
  working: [],
  queue: [],
  mentioned: [],
  everyone: false
}
const run = (env: NodeJS.ProcessEnv, signal = new AbortController().signal, timeoutMs?: number) =>
  runModerator({ bin: fake, cwd: process.cwd(), env: { ...process.env, ...env }, input, signal, timeoutMs })

test('builds the bare call', () => {
  const a = moderatorArgs()
  const at = (f: string) => a[a.indexOf(f) + 1]
  expect(at('--model')).toBe('haiku')
  expect(at('--tools')).toBe('')
  expect(at('--setting-sources')).toBe('')
  for (const f of ['--strict-mcp-config', '--no-session-persistence', '--json-schema', '--system-prompt']) expect(a).toContain(f)
  expect(at('--output-format')).toBe('json')
  expect(a.join(' ')).not.toContain('bypassPermissions')
})

test('asks for waits and drops in its schema', () => {
  const a = moderatorArgs()
  expect(a[a.indexOf('--json-schema') + 1]).toBe(
    '{"type":"object","properties":{"next":{"type":"array","items":{"type":"object","properties":{"agent":{"type":"string"},"after":{"type":"array","items":{"type":"string"}},"note":{"type":"string"}},"required":["agent","after"],"additionalProperties":false}},"drop":{"type":"array","items":{"type":"string"}},"skip":{"type":"array","items":{"type":"string"}},"askUser":{"type":"boolean"}},"required":["next","drop","skip","askUser"],"additionalProperties":false}'
  )
})

test('puts the role, who is working and the queue waits in the prompt', () => {
  const p = moderatorPrompt({
    ...input,
    role: 'ui first, then ps',
    working: ['a', 'b'],
    queue: [
      { agent: 'wk', after: ['ui', 'ps'] },
      { agent: 'ps', after: [] }
    ]
  })
  expect(p).toContain('Group role:\nui first, then ps')
  expect(p).toContain('Working now: @a, @b')
  expect(p).toContain('Queued: @wk (waits for @ui, @ps), @ps')
  expect(p).not.toContain('Already queued')
  const bare = moderatorPrompt(input)
  expect(bare).toContain('Group role:\n(none)')
  expect(bare).toContain('Working now: nobody')
  expect(bare).toContain('Queued: nobody')
})

test('moderatorPrompt carries the material rule only for material, right before the thread', () => {
  const p = moderatorPrompt({ ...input, material: true })
  expect(p).toContain(`${MATERIAL_RULE}\n\nThread (latest last):`)
  expect(moderatorPrompt(input)).not.toContain(MATERIAL_RULE)
})

test('moderatorPrompt lists attachment names', () => {
  const att = (name: string) => ({ id: name, name, mime: 'x/y', size: 1, kind: 'file' as const })
  const p = moderatorPrompt({
    ...input,
    messages: [
      { from: null, text: 'look', attachments: [att('a.png'), att('b.pdf')] },
      { from: null, text: 'plain' }
    ]
  })
  expect(p).toContain('<message from="user">look [attached: a.png, b.pdf]</message>')
  expect(p).toContain('<message from="user">plain</message>')
})

test('parses next entries with waits, notes and drops', () => {
  const out = JSON.stringify({
    structured_output: {
      next: [
        { agent: 'workiom5-assistance', after: ['ui-ux-specialist'], note: ' ui differs ' },
        { agent: 'ui-ux-specialist', after: [] }
      ],
      drop: ['workiom5-assistance']
    }
  })
  expect(parseModeratorOutput(out, members)).toEqual({
    next: [
      { agent: 'workiom5-assistance', after: ['ui-ux-specialist'], note: 'ui differs' },
      { agent: 'ui-ux-specialist', after: [], note: null }
    ],
    drop: ['workiom5-assistance'],
    skip: [],
    askUser: false
  })
})

test('falls back to result JSON', () => {
  const out = JSON.stringify({ result: '{"next":[{"agent":"workiom5-assistance","after":[]}],"drop":[]}' })
  expect(parseModeratorOutput(out, members)).toEqual({
    next: [{ agent: 'workiom5-assistance', after: [], note: null }],
    drop: [],
    skip: [],
    askUser: false
  })
})

test('normalizes loose handles in waits and drops', () => {
  const out = JSON.stringify({
    structured_output: {
      next: [
        { agent: '@UI-UX-Specialist', after: ['Workiom5 Assistance', 'nobody', '@workiom5-assistance'] },
        { agent: 'nobody', after: [] },
        { agent: 'ui-ux-specialist', after: ['workiom5-assistance'], note: 'dup' },
        { agent: 'Workiom5 Assistance', after: [] }
      ],
      drop: ['@Workiom5-Assistance', 'ghost', 'workiom5 assistance']
    }
  })
  expect(parseModeratorOutput(out, members)).toEqual({
    next: [
      { agent: 'ui-ux-specialist', after: ['workiom5-assistance'], note: null },
      { agent: 'workiom5-assistance', after: [], note: null }
    ],
    drop: ['workiom5-assistance'],
    skip: [],
    askUser: false
  })
})

test('cuts a long note', () => {
  const out = JSON.stringify({ structured_output: { next: [{ agent: 'ui-ux-specialist', after: [], note: 'n'.repeat(1000) }], drop: [] } })
  expect(parseModeratorOutput(out, members)?.next[0].note).toBe('n'.repeat(MODERATOR_NOTE_CHARS))
  expect(MODERATOR_NOTE_CHARS).toBe(300)
})

test('rejects an answer without next', () => {
  expect(parseModeratorOutput(JSON.stringify({ structured_output: { drop: [] } }), members)).toBeNull()
})

test('bad output is null', () => {
  expect(parseModeratorOutput('not json', members)).toBeNull()
  expect(parseModeratorOutput(JSON.stringify({ is_error: true }), members)).toBeNull()
})

test('prompt keeps the last 20 messages, each cut to 1500 chars', () => {
  const messages = Array.from({ length: 25 }, (_, i) => ({ from: null, text: `m${i}-` + 'x'.repeat(2000) }))
  const p = moderatorPrompt({ ...input, messages })
  expect(p).not.toContain('m4-')
  expect(p).toContain('m5-')
  expect(p).toContain('m24-')
  expect(p).not.toContain('x'.repeat(MODERATOR_MESSAGE_CHARS + 1))
  expect(MODERATOR_MESSAGES).toBe(20)
})

test('times out to null', async () => {
  const t = Date.now()
  expect(await run({ FAKE_MODERATOR_HANG: '1' }, undefined, 100)).toBeNull()
  expect(Date.now() - t).toBeLessThan(1000)
})

test('aborts to null', async () => {
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 20)
  expect(await run({ FAKE_MODERATOR_HANG: '1' }, ac.signal)).toBeNull()
})

test('returns the parsed answer', async () => {
  const out = JSON.stringify({ structured_output: { next: [{ agent: 'workiom5-assistance', after: [] }], drop: [] } })
  expect(await run({ FAKE_MODERATOR_OUT: out })).toEqual({
    next: [{ agent: 'workiom5-assistance', after: [], note: null }],
    drop: [],
    skip: [],
    askUser: false
  })
})

test('asks for skip and askUser in its prompt', () => {
  const a = moderatorArgs()
  const sys = a[a.indexOf('--system-prompt') + 1]
  expect(sys).toContain(
    'Answer "next": the members who should act, each with "after": the members it must wait for, and optionally a short "note" shown only to that member. Answer "drop": queued members who must not act yet. Answer "skip": members the latest message @mentions only to agree with, thank or refer to them, with nothing for them to do; only for a message from a member, never from the user. Answer "askUser": true only when the latest message asks the user to decide. Use handles only, no @ and no display names.'
  )
  expect(sys).toContain(
    'When the latest message asks the user to decide, set "askUser" to true and put the queued members that would act on that decision in "drop".'
  )
  expect(sys).toContain(
    '"@x is correct", "@x\'s TODO matches", "thanks @x" and "as @x said" only refer to x: put x in "skip" unless the message also asks x to do something.'
  )
})

test('normalizes skip like drop and reads askUser', () => {
  const out = JSON.stringify({
    structured_output: {
      next: [],
      drop: [],
      skip: ['@UI-UX-Specialist', 'ghost', 'workiom5 assistance', 'ui-ux-specialist'],
      askUser: true
    }
  })
  expect(parseModeratorOutput(out, members)).toEqual({
    next: [],
    drop: [],
    skip: ['ui-ux-specialist', 'workiom5-assistance'],
    askUser: true
  })
})

test('skip and askUser default to empty and false', () => {
  const none = JSON.stringify({ structured_output: { next: [] } })
  expect(parseModeratorOutput(none, members)).toEqual({ next: [], drop: [], skip: [], askUser: false })
  const loose = JSON.stringify({ structured_output: { next: [], skip: 'ui-ux-specialist', askUser: 'true' } })
  expect(parseModeratorOutput(loose, members)).toEqual({ next: [], drop: [], skip: [], askUser: false })
})

test('tells the moderator what @everyone means', () => {
  const sys = moderatorArgs()[moderatorArgs().indexOf('--system-prompt') + 1]
  expect(sys).toContain(
    'When the latest message is from the user and mentions no one, pick at least one member to answer.\nWhen the latest message is for @everyone, plan the whole flow from the group role: list every member the matching role rule needs, each with its waits, and nobody else. If no role rule fits, list every member, all starting together.'
  )
})

test('the prompt names @everyone only when the message is for everyone', () => {
  const line = 'The latest message is for @everyone.'
  expect(moderatorPrompt(input)).not.toContain(line)
  const p = moderatorPrompt({ ...input, mentioned: ['ui-ux-specialist'], everyone: true })
  expect(p).toContain(`Mentioned in the latest message: @ui-ux-specialist\n${line}`)
})

test("runModerator reports the call's cost", async () => {
  const out = JSON.stringify({
    is_error: false,
    uuid: 'u-1',
    total_cost_usd: 0.01,
    structured_output: { next: [], drop: [], skip: [], askUser: false },
    modelUsage: {
      'claude-haiku-5-5': { inputTokens: 5, outputTokens: 6, cacheReadInputTokens: 7, cacheCreationInputTokens: 8, costUSD: 0.01 }
    }
  })
  const calls: unknown[][] = []
  await runModerator({
    bin: fake,
    cwd: process.cwd(),
    env: { ...process.env, FAKE_MODERATOR_OUT: out },
    input,
    signal: new AbortController().signal,
    onCost: (c, id) => calls.push([c, id])
  })
  expect(calls).toEqual([
    [{ totalUsd: 0.01, models: { 'claude-haiku-5-5': { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, costUsd: 0.01 } } }, 'u-1']
  ])
})
