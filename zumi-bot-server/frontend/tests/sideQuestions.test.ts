import { describe, expect, it } from 'vitest'
import {
  SIDE_ASK_FIRST_TEXT,
  SIDE_WAIT_TEXT,
  askedByText,
  sourceGoneText,
  type SideAskLink,
  type SideQuestion,
  type SideState
} from '@zumibot/shared/btw'
import type { AgentSummary, ChatMeta, GroupInfo } from '@zumibot/shared/types'
import {
  askLinkText,
  btwRefusal,
  workflowRefusal,
  canAskAgain,
  canFollow,
  chipText,
  groupThreads,
  panelOrder,
  pickChips,
  routeSend,
  laterRefusal,
  sideTexts,
  sideThreads,
  threadCountText,
  threadLine,
  threadOf,
  tooLong,
  upsertSide
} from '../src/state/sideQuestions'

const side = (id: string, askedAt: number, question = 'How far?'): SideQuestion => ({
  id,
  askedAt,
  question,
  agent: 'helper',
  after: null,
  state: 'running',
  answer: ''
})

describe('side question state', () => {
  it('upsertSide replaces by id and keeps askedAt order without mutating the list', () => {
    const first = side('first', 1)
    const last = side('last', 3)
    const list = Object.freeze([last, first])
    const middle = side('middle', 2)
    expect(upsertSide(list, middle)).toEqual([first, middle, last])
    const updated = { ...last, answer: 'Almost done', state: 'done' as const }
    expect(upsertSide(list, updated)).toEqual([first, updated])
    expect(list).toEqual([last, first])
    expect(last.answer).toBe('')
    expect(upsertSide([], first)).toEqual([first])
  })

  it('panelOrder puts the oldest side question first and keeps ties stable', () => {
    const first = side('first', 1)
    const tied = side('tied', 1)
    const last = side('last', 3)
    const list = Object.freeze([last, first, tied])
    expect(panelOrder(list)).toEqual([first, tied, last])
    expect(list).toEqual([last, first, tied])
    expect(panelOrder([])).toEqual([])
  })

  it('chipText cuts long side questions with an ellipsis after the question limit', () => {
    expect(chipText(side('q', 1, 'How far?'))).toBe('btw · How far?')
    expect(chipText(side('q', 1, 'How far?'), 4)).toBe('btw · How …')
    expect(chipText(side('q', 1, 'Done'), 4)).toBe('btw · Done')
    expect(chipText(side('q', 1, 'x'.repeat(49)))).toBe(`btw · ${'x'.repeat(48)}…`)
    expect(chipText(side('q', 1, '😀🚀x'), 2)).toBe('btw · 😀🚀…')
  })
})

describe('routeSend', () => {
  it.each([
    ['/btw x', 'x'],
    ['/btw @a x', '@a x'],
    ['/btw', ''],
    ['/btw   ', ''],
    ['/btw \t @a x \n', '@a x'],
    ['/btw\nx', 'x']
  ])('routes %j as a side question, keeping the mention for the server', (text, question) => {
    expect(routeSend(text)).toEqual({ kind: 'btw', question })
  })

  it.each(['/run-workflow x', '/run-workflow', '/run-workflow\nDaily report', '/run-workflow   Daily report y'])(
    'routes %j as a workflow start',
    (text) => {
      expect(routeSend(text)).toEqual({ kind: 'workflow' })
    }
  )

  it.each(['/later 9am check CI', '/later', '/later\nin 2h x'])('routes %j as a /later', (text) => {
    expect(routeSend(text)).toEqual({ kind: 'later' })
  })

  it.each(['/laterx y', ' /later 9am x', 'hi /later 9am x'])('routes %j as a normal send, not a /later', (text) => {
    expect(routeSend(text)).toEqual({ kind: 'send' })
  })

  it('refuses a typed /later only where a notice is given', () => {
    expect(laterRefusal('/later 9am x', 'Start the chat first')).toBe('Start the chat first')
    expect(laterRefusal('/later 9am x', undefined)).toBeNull()
    expect(laterRefusal('hello', 'Start the chat first')).toBeNull()
  })

  it.each(['/run-workflowx y', ' /run-workflow x', '/RUN-WORKFLOW x', 'hello\n/run-workflow x', 'a /run-workflow x'])(
    'routes %j as a normal send',
    (text) => {
      expect(routeSend(text)).toEqual({ kind: 'send' })
    }
  )

  it.each(['/btwx y', 'hello', ' /btw x', '/BTW x', '/btw@a x', 'hello\n/btw x', ''])('routes %j as a normal send', (text) => {
    expect(routeSend(text)).toEqual({ kind: 'send' })
  })
})

describe('workflowRefusal', () => {
  it('is the notice for a typed leading /run-workflow, else null', () => {
    expect(workflowRefusal('/run-workflow x', 'Open a chat first')).toBe('Open a chat first')
    expect(workflowRefusal('/run-workflow', 'Open a chat first')).toBe('Open a chat first')
    expect(workflowRefusal('/btw x', 'Open a chat first')).toBeNull()
    expect(workflowRefusal('hello', 'Open a chat first')).toBeNull()
    expect(workflowRefusal('/run-workflow x', undefined)).toBeNull()
  })
})

describe('side ask links', () => {
  const link = (state: SideAskLink['state']): SideAskLink => ({ agent: 'card-writer', chatId: 'c2', entryId: 'e2', state })

  it('askLinkText names the asked agent by display name, and the state', () => {
    expect(askLinkText(link('running'))).toBe('Side question to @Card Writer · Asking…')
    expect(askLinkText(link('done'))).toBe('Side question to @Card Writer · Done')
    expect(askLinkText(link('error'))).toBe('Side question to @Card Writer · Failed')
    expect(askLinkText(link('stopped'))).toBe('Side question to @Card Writer · Stopped')
  })

  it('canAskAgain is true for the last failed or stopped entry of a thread the user asked, never for one an agent asked', () => {
    const base = side('x', 1)
    const of = (q: SideQuestion) => canAskAgain(q, sideThreads([q])[0])
    expect(of({ ...base, state: 'error' })).toBe(true)
    expect(of({ ...base, state: 'stopped' })).toBe(true)
    expect(of({ ...base, state: 'running' })).toBe(false)
    expect(of({ ...base, state: 'done' })).toBe(false)
    expect(of({ ...base, state: 'error', from: 'a' })).toBe(false)
    expect(of({ ...base, state: 'stopped', from: 'a' })).toBe(false)
  })
})

const chatOf = (over: Partial<ChatMeta>): ChatMeta => ({
  id: 'c1',
  agentName: 'helper',
  sessionId: null,
  cwd: '/tmp',
  title: 'Chat',
  createdAt: 1,
  updatedAt: 1,
  inFlight: false,
  ...over
})
const agentOf = (name: string, error: string | null = null): AgentSummary => ({
  filePath: `/a/${name}.md`,
  name,
  description: '',
  color: null,
  icon: null,
  error,
  builtIn: false
})
const groupOf = (members: string[]): GroupInfo => ({ members, sessions: {}, seen: {}, role: '', active: [], queue: [] })
const withState = (id: string, state: SideState, askedAt = 1): SideQuestion => ({ ...side(id, askedAt), state })

const single = chatOf({})
const room = chatOf({ agentName: '', group: groupOf(['helper', 'writer', 'broken']) })
const ab = chatOf({ agentName: 'coder', asked: { by: 'planner', from: 'src', fromTitle: 'Plan', chain: [] } })
const agents = [agentOf('helper'), agentOf('writer'), agentOf('broken', 'bad file'), agentOf('coder'), agentOf('planner')]

describe('side question pick rules', () => {
  it('a single chat has no chips and sends the trimmed question as typed', () => {
    expect(pickChips(single, agents, true, [])).toEqual([])
    expect(sideTexts(single, '', ' hi ')).toEqual(['hi'])
  })

  it('a room offers Auto plus each member that loads, and mentions only a picked member', () => {
    const chips = pickChips(room, agents, true, [])
    expect(chips.map((c) => c.key)).toEqual(['auto', 'agent:helper', 'agent:writer'])
    expect(chips.every((c) => c.disabled === null)).toBe(true)
    expect(sideTexts(room, 'auto', 'hi')).toEqual(['hi'])
    expect(sideTexts(room, 'agent:writer', 'hi')).toEqual(['@writer hi'])
  })

  it('an asked chat offers its agent, the asker and Both', () => {
    const chips = pickChips(ab, agents, true, [])
    expect(chips.map((c) => c.key)).toEqual(['agent:coder', 'agent:planner', 'both'])
    expect(chips.map((c) => c.label)).toEqual(['Coder', 'Planner', 'Both'])
    expect(chips.map((c) => c.agent)).toEqual(['coder', 'planner', null])
    expect(sideTexts(ab, 'agent:coder', 'hi')).toEqual(['hi'])
    expect(sideTexts(ab, 'agent:planner', 'hi')).toEqual(['@planner hi'])
    expect(sideTexts(ab, 'both', 'hi')).toEqual(['hi', '@planner hi'])
  })

  it('a typed leading handle wins over the pick', () => {
    expect(sideTexts(ab, 'both', '@writer hi')).toEqual(['@writer hi'])
    expect(sideTexts(room, 'agent:helper', '@writer hi')).toEqual(['@writer hi'])
  })

  it('an empty question sends nothing', () => {
    expect(sideTexts(ab, 'both', '   ')).toEqual([])
    expect(sideTexts(room, 'auto', '')).toEqual([])
    expect(sideTexts(ab, 'agent:planner', '@writer')).toEqual([])
  })

  it('tooLong sees the mention a pick adds past the 8000 limit', () => {
    const max = 'x'.repeat(8000)
    expect(tooLong(sideTexts(ab, 'both', max))).toBe(true)
    expect(tooLong(sideTexts(ab, 'agent:coder', max))).toBe(false)
    expect(tooLong(sideTexts(ab, 'both', 'hi'))).toBe(false)
  })

  it('a deleted source greys out the asker and Both with the reason', () => {
    const chips = pickChips(ab, agents, false, [])
    expect(chips.map((c) => c.disabled)).toEqual([null, sourceGoneText('planner'), sourceGoneText('planner')])
  })

  it('Both needs two free slots, and a missing source wins over that reason', () => {
    const open2 = [withState('a', 'running'), withState('b', 'picking'), withState('c', 'done')]
    const both = (list: SideQuestion[], exists = true) => pickChips(ab, agents, exists, list)[2]
    expect(both(open2).disabled).toBe('Both needs 2 free side question slots')
    expect(both([withState('a', 'running'), withState('c', 'error')]).disabled).toBeNull()
    expect(both(open2, false).disabled).toBe(sourceGoneText('planner'))
    expect(pickChips(ab, agents, true, open2)[1].disabled).toBeNull()
  })

  it('an archived chat gets the same chips', () => {
    const archived = { ...ab, archivedAt: 5 }
    expect(pickChips(archived, agents, true, [])).toEqual(pickChips(ab, agents, true, []))
  })
})

describe('side threads', () => {
  const entry = (id: string, askedAt: number, over: Partial<SideQuestion> = {}): SideQuestion => ({
    ...side(id, askedAt),
    state: 'done',
    ...over
  })

  it('sideThreads groups follow-ups under their root', () => {
    const r = entry('r', 1)
    const f1 = entry('f1', 2, { thread: 'r' })
    const f2 = entry('f2', 3, { thread: 'r' })
    const s = entry('s', 4)
    const threads = sideThreads([f2, r, f1, s])
    expect(threads.map((t) => [t.id, t.entries.map((q) => q.id)])).toEqual([
      ['r', ['r', 'f1', 'f2']],
      ['s', ['s']]
    ])
    expect(threads[0].last).toBe(f2)
    expect(threads[0].root).toBe(r)
    expect(threadOf(threads, 'f1')).toBe(threads[0])
    expect(threadOf(threads, 'nope')).toBeUndefined()
  })

  it('an orphan follow-up stands alone', () => {
    const f = entry('f', 2, { thread: 'gone' })
    const threads = sideThreads([f])
    expect(threads).toHaveLength(1)
    expect(threads[0].id).toBe('f')
    expect(threads[0].root).toBe(f)
  })

  it('status is running while any entry is open, else the last entry state', () => {
    const r = entry('r', 1)
    const running = sideThreads([r, entry('f', 2, { thread: 'r', state: 'running' })])[0]
    expect(running.open).toBe(true)
    expect(running.status).toBe('running')
    const failed = sideThreads([r, entry('f', 2, { thread: 'r', state: 'error' })])[0]
    expect(failed.open).toBe(false)
    expect(failed.status).toBe('error')
    expect(sideThreads([r])[0].status).toBe('done')
  })

  it('threadLine describes the thread by its last entry', () => {
    const line = (...list: SideQuestion[]) => threadLine(sideThreads(list)[0])
    expect(line(entry('r', 1, { state: 'picking', agent: null }))).toEqual({ text: 'Picking who answers…', tone: 'live' })
    expect(line(entry('r', 1, { state: 'running' }))).toEqual({ text: 'Answering…', tone: 'live' })
    expect(line(entry('r', 1), entry('f', 2, { thread: 'r', state: 'running' }))).toEqual({ text: 'Answering follow-up…', tone: 'live' })
    expect(line(entry('r', 1, { state: 'error', error: 'Took too long' }))).toEqual({ text: 'Took too long', tone: 'error' })
    expect(line(entry('r', 1, { state: 'error' }))).toEqual({ text: 'Could not answer', tone: 'error' })
    expect(line(entry('r', 1, { state: 'stopped' }))).toEqual({ text: 'Stopped', tone: 'muted' })
    expect(line(entry('r', 1, { answer: '\n\n  First line\nSecond' }))).toEqual({ text: 'First line', tone: 'muted' })
  })

  it('groupThreads groups by anchor, newest group first, newest root first', () => {
    const at = (id: string, askedAt: number, after: string | null) => entry(id, askedAt, { after })
    const threads = sideThreads([at('a', 1, 'x'), at('b', 3, 'y'), at('c', 5, 'x')])
    const groups = groupThreads(threads, (ms) => `t${ms}`)
    expect(groups.map((g) => [g.key, g.label, g.rows.map((t) => t.id)])).toEqual([
      ['x', 'This reply', ['c', 'a']],
      ['y', 't3', ['b']]
    ])
    expect(groupThreads(sideThreads([at('n', 1, null)]), String)[0].key).toBe('start')
  })

  it('canFollow refuses in the server order and allows a finished single-chat thread', () => {
    const of = (...list: SideQuestion[]) => sideThreads(list)[0]
    expect(canFollow(of(entry('r', 1)), single, true)).toBeNull()
    expect(canFollow(of(entry('r', 1, { from: 'a' })), single, true)).toBe(askedByText('a'))
    expect(canFollow(of(entry('r', 1, { state: 'running' })), single, true)).toBe(SIDE_WAIT_TEXT)
    // A picking room root has no agent yet but is open: the wait wins, as on the server.
    expect(canFollow(of(entry('r', 1, { state: 'picking', agent: null })), single, true)).toBe(SIDE_WAIT_TEXT)
    expect(canFollow(of(entry('r', 1, { state: 'error', agent: null })), single, true)).toBe(SIDE_ASK_FIRST_TEXT)
    const mention = of(entry('r', 1, { agent: 'planner', mention: true }))
    expect(canFollow(mention, ab, false)).toBe(sourceGoneText('planner'))
    expect(canFollow(mention, ab, true)).toBeNull()
  })

  it('canAskAgain only offers the last entry of a thread', () => {
    const rootStopped = entry('r', 1, { state: 'stopped' })
    const followStopped = entry('f', 2, { thread: 'r', state: 'stopped' })
    const t = sideThreads([rootStopped, followStopped])[0]
    expect(canAskAgain(rootStopped, t)).toBe(false)
    expect(canAskAgain(followStopped, t)).toBe(true)
    const agentRoot = entry('a', 1, { state: 'error', from: 'x' })
    expect(canAskAgain(agentRoot, sideThreads([agentRoot])[0])).toBe(false)
  })

  it('threadCountText shows a count from two entries', () => {
    const r = entry('r', 1)
    expect(threadCountText(sideThreads([r])[0])).toBeNull()
    expect(threadCountText(sideThreads([r, entry('a', 2, { thread: 'r' }), entry('b', 3, { thread: 'r' })])[0])).toBe('3 questions')
  })
})

describe('btwRefusal', () => {
  it('refuses a leading /btw only where a notice is set', () => {
    expect(btwRefusal('/btw what now', 'No')).toBe('No')
    expect(btwRefusal('/btw', 'No')).toBe('No')
    expect(btwRefusal('/btw what now', undefined)).toBeNull()
  })
  it('lets ordinary text through, /btw later in the text included', () => {
    expect(btwRefusal('hello /btw there', 'No')).toBeNull()
    expect(btwRefusal('/btwx', 'No')).toBeNull()
  })
})
