import { expect, test } from 'vitest'
import type { ChatItem } from '@zumibot/shared/types'
import {
  askedLead,
  askedSideNote,
  askedThread,
  askingSideNote,
  FOLLOW_LEAD,
  FOLLOW_LEAD_CUT,
  followExchange,
  followMessage,
  seedWith,
  SIDE_NOTE,
  seededSideMessage,
  sideContext,
  sideMessage,
  unseenEntries
} from '../../src/core/btw/sidePrompt'
import { threadLines } from '../../src/core/chat/groupPrompts'

const note =
  'The user is asking you a side question with /btw while your main work goes on in another process. Answer only this question, briefly, from what you already know in this conversation. You cannot use tools here. Do not continue, restart or change the main work; this answer does not affect it.'
const items: ChatItem[] = [
  { type: 'user', id: 'u1', text: 'start', ts: 1 },
  { type: 'assistant', id: 'a1', text: 'working', ts: 2, agent: 'a', turn: 't1' },
  { type: 'assistant', id: 'me1', text: 'my work', ts: 3, agent: 'me', turn: 't2' }
]

test('sideMessage without a thread puts the side note before the question', () => {
  expect(SIDE_NOTE).toBe(note)
  expect(sideMessage('how far?', null)).toBe(`${note}\n<btw>how far?</btw>`)
  expect(sideMessage('how far?', [])).toBe(`${note}\n<btw>how far?</btw>`)
})

test('sideMessage starts with room thread lines without turn reasons', () => {
  const entries = [
    { from: null, text: 'start' },
    { from: 'ui-ux-specialist', text: 'working' }
  ]
  const lines = ['<message from="user">start</message>', '<message from="ui-ux-specialist" name="Ui Ux Specialist">working</message>']
  expect(threadLines(entries)).toEqual(lines)
  expect(sideMessage('how far?', entries)).toBe(`${lines.join('\n')}\n${note}\n<btw>how far?</btw>`)
})

test('seededSideMessage restores visible items before the side question', () => {
  expect(seededSideMessage(items, 'how far?')).toBe(
    "[ZumiBot] This chat's earlier session expired, so the earlier conversation is restored below from saved history. Treat it as context only.\n\n" +
      '<earlier_conversation>\nUser: start\n\nA: working\n\nMe: my work\n</earlier_conversation>\n\n' +
      `<new_message>\n${note}\n<btw>how far?</btw>\n</new_message>`
  )
})

test("unseenEntries includes another member's live text but not my own", () => {
  expect(unseenEntries(items, null, 'me')).toEqual([
    { from: null, text: 'start' },
    { from: 'a', text: 'working' }
  ])
  expect(items[1]).toHaveProperty('turn', 't1')
  expect(items[2]).toHaveProperty('turn', 't2')
})

test('unseenEntries starts after afterId', () => {
  expect(unseenEntries(items, 'u1', 'me')).toEqual([{ from: 'a', text: 'working' }])
  expect(unseenEntries(items, 'a1', 'me')).toEqual([])
})

test('askedSideNote names the asking agent and keeps tools off', () => {
  const note = askedSideNote('a')
  expect(note).toContain('@a')
  expect(note).toContain('You cannot use tools here')
  expect(note).not.toContain('/btw')
  expect(note).not.toContain('side_question')
})

test('askingSideNote names side_question and the agents it can reach', () => {
  const note = askingSideNote(['b', 'c'])
  expect(note).toContain('side_question')
  expect(note).toContain('@b')
  expect(note).toContain('@c')
  expect(askingSideNote([])).toBe(SIDE_NOTE)
})

test('the side messages take another note', () => {
  expect(sideMessage('how far?', null, 'Other note')).toBe('Other note\n<btw>how far?</btw>')
  expect(seededSideMessage(items, 'how far?', null, 'Other note')).toContain(
    '<new_message>\nOther note\n<btw>how far?</btw>\n</new_message>'
  )
})

const ab: ChatItem[] = [
  { type: 'user', id: 'u', text: 'Write the CSV parser', ts: 1, from: 'planner' },
  {
    type: 'tool',
    id: 't',
    name: 'Bash',
    input: { command: 'npm test\nmore' },
    result: 'ok',
    isError: false,
    blocked: false,
    ts: 2,
    turn: 'live'
  },
  { type: 'assistant', id: 'a', text: 'Parser half done', ts: 3, turn: 'live' },
  { type: 'notice', id: 'n', kind: 'stopped', text: 'Stopped', ts: 4 }
]
test('askedThread keeps the asker message, live text and one line per tool step', () => {
  expect(askedThread(ab, 'planner', 'coder')).toEqual({
    cut: false,
    entries: [
      { from: 'planner', text: 'Write the CSV parser' },
      { from: 'coder', text: 'Used Bash(npm test)' },
      { from: 'coder', text: 'Parser half done' }
    ]
  })
})
test('askedThread over the cap keeps the first message and the newest', () => {
  const many: ChatItem[] = [
    ab[0],
    ...Array.from({ length: 50 }, (_, n): ChatItem => ({
      type: 'assistant',
      id: `a${n}`,
      text: `step ${n} ${'x'.repeat(100)}`,
      ts: 10 + n
    }))
  ]
  const { entries, cut } = askedThread(many, 'planner', 'coder', 1000)
  expect(cut).toBe(true)
  expect(entries[0]).toEqual({ from: 'planner', text: 'Write the CSV parser' })
  expect(entries.at(-1)!.text).toContain('step 49')
  expect(entries.reduce((n, e) => n + e.text.length, 0)).toBeLessThanOrEqual(1000)
})
test('sideMessage puts the lead before the thread lines', () => {
  const lines = sideMessage('How is it going?', [{ from: 'coder', text: 'Half done' }], SIDE_NOTE, askedLead('coder', false)).split('\n')
  expect(lines[0]).toBe(askedLead('coder', false))
  expect(lines[1]).toContain('Half done')
  expect(lines.at(-1)).toBe('<btw>How is it going?</btw>')
  // The note stays just before the question, whichever note the run gets.
  expect(sideMessage('How is it going?', null, 'Other note', askedLead('coder', false))).toBe(
    `${askedLead('coder', false)}\nOther note\n<btw>How is it going?</btw>`
  )
})
test('askedLead names the asked agent and says when older messages were left out', () => {
  expect(askedLead('coder', false)).toContain('@coder')
  expect(askedLead('coder', true)).toMatch(/left out/)
})

test('sideContext joins lead and thread lines', () => {
  expect(sideContext(null)).toBe('')
  expect(sideContext([{ from: null, text: 'start' }], 'Lead:')).toBe('Lead:\n<message from="user">start</message>')
})

test('seedWith restores visible items before the message', () => {
  expect(seedWith(items, 'hello')).toContain('<earlier_conversation>\nUser: start')
  expect(seedWith(items, 'hello')).toContain('<new_message>\nhello\n</new_message>')
})

const pair = (n: number, len = 100) => ({ question: `Q${n}`, answer: `A${n}${'x'.repeat(len)}` })
const pairText = (e: { question: string; answer: string }) =>
  `<btw>${e.question}</btw>\n<answer>${e.answer.trim() || '(no answer)'}</answer>`

test('followMessage puts context, note, exchange, then the question', () => {
  const earlier = [{ question: 'Q1', answer: 'A1' }]
  expect(followMessage('', SIDE_NOTE, earlier, 'Q2')).toBe(
    `${SIDE_NOTE}\n${FOLLOW_LEAD}\n<btw>Q1</btw>\n<answer>A1</answer>\n<btw>Q2</btw>`
  )
  expect(followMessage('ctx', SIDE_NOTE, earlier, 'Q2').startsWith('ctx\n')).toBe(true)
})

test('an earlier entry without text reads (no answer)', () => {
  expect(followExchange([{ question: 'Q1', answer: '  ' }]).pairs).toEqual(['<btw>Q1</btw>\n<answer>(no answer)</answer>'])
})

test('followExchange keeps the first pair and the newest that fit', () => {
  const all = [1, 2, 3, 4, 5].map((n) => pair(n))
  const texts = all.map(pairText)
  const max = texts[0].length + texts[3].length + texts[4].length
  expect(followExchange(all, max)).toEqual({ pairs: [texts[0], texts[3], texts[4]], cut: true })
  expect(followExchange(all, max * 10)).toEqual({ pairs: texts, cut: false })
})

test('followMessage says when pairs were left out', () => {
  const big = Array.from({ length: 5 }, (_, n) => pair(n, 10_000))
  const out = followMessage('', SIDE_NOTE, big, 'Q9')
  expect(out).toContain(FOLLOW_LEAD_CUT)
  expect(out).not.toContain(`${FOLLOW_LEAD}\n`)
  expect(followMessage('', SIDE_NOTE, [pair(1)], 'Q9')).not.toContain(FOLLOW_LEAD_CUT)
})
