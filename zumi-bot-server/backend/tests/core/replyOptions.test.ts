import { expect, test } from 'vitest'
import type { ChatItem, ChatMeta } from '@zumibot/shared/types'
import {
  REPLY_MESSAGE_CHARS,
  REPLY_QUESTION_MAX_CHARS,
  REPLY_SUMMARY_MAX_CHARS,
  REPLY_TAIL_CHARS,
  asksUser,
  parseReplyOptions,
  replyInput,
  replyOptionsArgs,
  replyOptionsPrompt,
  skipsChat
} from '../../src/core/chat/replyOptions'

const meta = {
  id: 'c1',
  agentName: 'git-helper',
  sessionId: null,
  cwd: '/w',
  title: 't',
  createdAt: 0,
  updatedAt: 0,
  inFlight: false
} as ChatMeta
const room = { ...meta, agentName: '', group: { members: ['alice', 'bob'] } as never } as ChatMeta

const user = (id: string, text: string): ChatItem => ({ type: 'user', id, text, ts: 0 })
const said = (id: string, text: string, agent?: string): ChatItem => ({ type: 'assistant', id, text, ts: 0, ...(agent ? { agent } : {}) })
const out = (options: unknown, more: object = {}) => JSON.stringify({ structured_output: { options, ...more } })

test('runs on haiku with no tools, settings, MCP or session', () => {
  const args = replyOptionsArgs()
  expect(args.slice(0, 3)).toEqual(['-p', '--model', 'haiku'])
  expect(args).toContain('--no-session-persistence')
  expect(args).toContain('--strict-mcp-config')
  expect(args[args.indexOf('--tools') + 1]).toBe('')
  expect(args[args.indexOf('--setting-sources') + 1]).toBe('')
  expect(args[args.indexOf('--json-schema') + 1]).toContain('"maxItems":3')
  expect(args[args.indexOf('--json-schema') + 1]).toContain('"question"')
  expect(args[args.indexOf('--json-schema') + 1]).toContain('"summary"')
})

test('asksUser reads only the last paragraph', () => {
  expect(asksUser('Pick one.\n\nNative or Subagent-driven?')).toBe(true)
  expect(asksUser('Which one?\n\nDone, all set.')).toBe(false)
  expect(asksUser('هل أبدأ؟')).toBe(true)
  expect(asksUser('Ready?\n\n  \n')).toBe(true)
  expect(asksUser('')).toBe(false)
})

test('asksUser takes the fullwidth question mark too', () => {
  expect(asksUser('どちらにしますか？')).toBe(true)
})

test('asksUser takes a question followed by its list of choices', () => {
  expect(asksUser('Which approach?\n\n1. Native\n2. Subagent-driven')).toBe(true)
  expect(asksUser('Pick one?\n\n- Local only\n- Local and remote')).toBe(true)
  expect(asksUser('Done.\n\n- Local only\n- Local and remote')).toBe(false)
  expect(asksUser('- A?\n- B')).toBe(true)
  expect(asksUser('Which one?\n\nDone, all set.')).toBe(false)
})

test('skipsChat: plain chats and rooms run, chats answered elsewhere do not', () => {
  expect(skipsChat(meta)).toBe(false)
  expect(skipsChat(room)).toBe(false)
  for (const key of ['asked', 'task', 'cardComments', 'attempt', 'workflow', 'workflowTest', 'channel', 'voice'])
    expect(skipsChat({ ...meta, [key]: {} as never }), key).toBe(true)
})

test('a single chat reads its last reply and the message before it', () => {
  const items = [user('u1', 'rename it'), said('a1', 'Local only, or remote too?')]
  expect(replyInput(meta, items)).toEqual({
    after: 'a1',
    input: { speakers: ['Git Helper'], message: 'rename it', reply: 'Local only, or remote too?' }
  })
})

test('nothing to read unless the chat ends on a reply that asks', () => {
  const base = [user('u1', 'go')]
  expect(replyInput(meta, [...base, { type: 'error', id: 'e', text: 'boom?', ts: 0 }])).toBeNull()
  expect(replyInput(meta, [...base, { type: 'notice', id: 'n', kind: 'stopped', text: 'Stopped?', ts: 0 }])).toBeNull()
  expect(
    replyInput(meta, [...base, { type: 'tool', id: 't', name: 'Bash', input: {}, result: '?', isError: false, blocked: false, ts: 0 }])
  ).toBeNull()
  expect(replyInput(meta, [...base, said('a1', '   ')])).toBeNull()
  expect(replyInput(meta, [...base, said('a1', 'Want it?\n\nDone.')])).toBeNull()
  expect(replyInput(meta, [])).toBeNull()
})

test("a room reads every member's last reply of the round, so an asking member that finished first still counts", () => {
  const items = [
    user('u0', 'old'),
    said('z0', 'Earlier question?', 'bob'),
    user('u1', 'review the plan'),
    said('a1', 'Draft one?', 'alice'),
    said('a2', 'Option A or B?', 'alice'),
    said('b1', 'Done reviewing.', 'bob')
  ]
  expect(replyInput(room, items)).toEqual({
    after: 'b1',
    input: {
      speakers: ['Alice', 'Bob'],
      message: 'review the plan',
      reply: 'Alice:\nOption A or B?\n\nBob:\nDone reviewing.'
    }
  })
})

test("a room's own held notice after the asking reply does not hide it", () => {
  const items: ChatItem[] = [
    user('u1', '@alice draft it, then @bob review'),
    said('a1', 'Approach A or B?', 'alice'),
    { type: 'notice', id: 'n1', kind: 'held', text: 'Bob waits for your answer.', ts: 0 }
  ]
  expect(replyInput(room, items)).toEqual({
    after: 'n1',
    input: { speakers: ['Alice'], message: '@alice draft it, then @bob review', reply: 'Alice:\nApproach A or B?' }
  })
  const moderated = [...items, { type: 'notice' as const, id: 'n2', kind: 'moderator' as const, text: 'x', ts: 0 }]
  expect(replyInput(room, moderated)?.after).toBe('n2')
})

test('a single chat still needs its last item to be the reply', () => {
  const items: ChatItem[] = [user('u1', 'go'), said('a1', 'A or B?'), { type: 'notice', id: 'n1', kind: 'held', text: 'x', ts: 0 }]
  expect(replyInput(meta, items)).toBeNull()
})

test('a room where no member asks has nothing to read', () => {
  const items = [user('u1', 'go'), said('a1', 'Done.', 'alice'), said('b1', 'Also done.', 'bob')]
  expect(replyInput(room, items)).toBeNull()
})

test('the reply keeps its end when it is long', () => {
  const text = 'x'.repeat(5000) + '…which one?'
  const r = replyInput(meta, [user('u1', 'go'), said('a1', text)])
  expect([...r!.input.reply].length).toBe(REPLY_TAIL_CHARS)
  expect(r!.input.reply.endsWith('which one?')).toBe(true)
})

test('no user message reads as an empty one', () => {
  expect(replyInput(meta, [said('a1', 'Ready?')])?.input.message).toBe('')
})

test('the prompt names the speakers, the message and the reply', () => {
  const p = replyOptionsPrompt({ speakers: ['Git Helper'], message: 'rename it', reply: 'Local or remote?' })
  expect(p).toContain('Assistant: Git Helper')
  expect(p).toContain('<message>rename it</message>')
  expect(p).toContain('<reply>Local or remote?</reply>')
  expect(replyOptionsPrompt({ speakers: ['Alice', 'Bob'], message: '', reply: 'x?' })).toContain('Assistants: Alice, Bob')
  const long = replyOptionsPrompt({ speakers: ['A'], message: 'm'.repeat(REPLY_MESSAGE_CHARS + 50), reply: 'x?' })
  expect(long).toContain('m'.repeat(REPLY_MESSAGE_CHARS) + '…</message>')
})

test('reads the options, the question and the summary from structured output, or from a JSON result', () => {
  expect(
    parseReplyOptions(out(['  Native ', 'Subagent-driven'], { question: ' Which way should I build it? ', summary: 'Wrote an 8-task plan.\n Nothing is built yet.' }))
  ).toEqual({ options: ['Native', 'Subagent-driven'], question: 'Which way should I build it?', summary: 'Wrote an 8-task plan. Nothing is built yet.' })
  expect(parseReplyOptions(JSON.stringify({ result: JSON.stringify({ options: ['Yes, commit it'] }) }))).toEqual({
    options: ['Yes, commit it'],
    question: '',
    summary: ''
  })
  expect(parseReplyOptions(out([]))).toEqual({ options: [], question: '', summary: '' })
  expect(parseReplyOptions(out(['Yes,\n  go   ahead']))?.options).toEqual(['Yes, go ahead'])
})

test('a question or summary that is too long or not text is left out, the options kept', () => {
  const r = parseReplyOptions(out(['A', 'B'], { question: 'q'.repeat(REPLY_QUESTION_MAX_CHARS + 1), summary: 's'.repeat(REPLY_SUMMARY_MAX_CHARS + 1) }))
  expect(r).toEqual({ options: ['A', 'B'], question: '', summary: '' })
  expect(parseReplyOptions(out(['A', 'B'], { question: 5, summary: null }))).toEqual({ options: ['A', 'B'], question: '', summary: '' })
  const fit = parseReplyOptions(out(['A', 'B'], { question: 'q'.repeat(REPLY_QUESTION_MAX_CHARS), summary: 's'.repeat(REPLY_SUMMARY_MAX_CHARS) }))
  expect(fit?.question.length).toBe(REPLY_QUESTION_MAX_CHARS)
  expect(fit?.summary.length).toBe(REPLY_SUMMARY_MAX_CHARS)
})

test('drops options that would run as a command or a mention, blank, too long or repeated', () => {
  expect(parseReplyOptions(out(['/commit', '@alice do it', '', 'x'.repeat(81), 'Yes', 'yes', 'x'.repeat(80)]))?.options).toEqual([
    'Yes',
    'x'.repeat(80)
  ])
})

test('more than three usable options means none', () => {
  expect(parseReplyOptions(out(['A', 'B', 'C', 'D']))?.options).toEqual([])
})

test('an unusable answer is null', () => {
  expect(parseReplyOptions('not json')).toBeNull()
  expect(parseReplyOptions(JSON.stringify({ is_error: true, structured_output: { options: ['A'] } }))).toBeNull()
  expect(parseReplyOptions(out('x'))).toBeNull()
  expect(parseReplyOptions(JSON.stringify({ result: 'plain text' }))).toBeNull()
  expect(parseReplyOptions(out([1, 'A']))).toBeNull()
})
