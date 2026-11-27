import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@zumibot/shared/types'
import type { SideQuestion } from '@zumibot/shared/btw'
import { ASK_SIDE_TOOL, ASK_TOOL } from '@zumibot/shared/agentAsk'
import {
  agentKeyAfter,
  endsInToolItems,
  endsInTools,
  foldTools,
  groupItems,
  lastContentRow,
  rowIndexOf,
  thoughtLabel,
  thoughtPreview,
  thoughtTitle,
  withAcks,
  type AgentItem
} from '../src/state/messageGroups'

const user = (id: string): ChatItem => ({ type: 'user', id, text: id, ts: 0 })
const assistant = (id: string, ts = 0): Extract<ChatItem, { type: 'assistant' }> => ({ type: 'assistant', id, text: id, ts })
const tool = (id: string, ts = 0, doneTs?: number): Extract<ChatItem, { type: 'tool' }> => ({
  type: 'tool',
  id,
  name: 'Bash',
  input: {},
  result: null,
  isError: false,
  blocked: false,
  ts,
  ...(doneTs === undefined ? {} : { doneTs })
})
const thinking = (id: string, ts = 0, doneTs?: number): Extract<ChatItem, { type: 'thinking' }> => ({
  type: 'thinking',
  id,
  text: `${id} text`,
  ts,
  ...(doneTs === undefined ? {} : { doneTs })
})
const approval = (id: string): Extract<ChatItem, { type: 'approval' }> => ({
  type: 'approval',
  id,
  toolUseId: null,
  toolName: 'Bash',
  input: {},
  description: null,
  reason: null,
  status: 'pending',
  ts: 0
})
const notice = (id: string): ChatItem => ({ type: 'notice', id, kind: 'stopped', text: 'Stopped.', ts: 0 })
const error = (id: string): ChatItem => ({ type: 'error', id, text: 'boom', ts: 0 })

const side = (id: string, after: string | null, askedAt = 0): SideQuestion => ({
  id,
  after,
  askedAt,
  question: 'How far?',
  agent: null,
  state: 'picking',
  answer: ''
})

const shape = (items: ChatItem[], sides?: SideQuestion[], fromStart = true): string[] =>
  groupItems(items, sides, fromStart).map((r) =>
    r.kind === 'agent' ? `agent:${r.items.map((i) => i.id).join(',')}` : `${r.kind}:${r.kind === 'side' ? r.thread.id : r.item.id}`
  )

describe('groupItems', () => {
  it('puts a whole agent turn (text, tools, approvals) in one group', () => {
    expect(shape([user('u1'), assistant('a1'), tool('t1'), approval('p1'), assistant('a2'), user('u2')])).toEqual([
      'user:u1',
      'agent:a1,t1,p1,a2',
      'user:u2'
    ])
  })

  it('splits agent groups at notices and errors', () => {
    expect(shape([assistant('a1'), notice('n1'), assistant('a2'), error('e1'), tool('t1')])).toEqual([
      'agent:a1',
      'other:n1',
      'agent:a2',
      'other:e1',
      'agent:t1'
    ])
  })

  it("leaves out an older chat's kept notice", () => {
    const kept: ChatItem = { type: 'notice', id: 'k1', kind: 'kept', text: 'Version 1 ran 2 commands.', ts: 0 }
    expect(shape([user('u1'), kept, assistant('a1')])).toEqual(['user:u1', 'agent:a1'])
  })

  it('keys an agent group by the row before it, so the key holds while its first item arrives', () => {
    expect(groupItems([assistant('a1'), tool('t1')])[0].key).toBe(agentKeyAfter(null))
    expect(groupItems([user('u1'), assistant('a1')])[1].key).toBe(agentKeyAfter('u1'))
  })

  it('returns no rows for no items', () => {
    expect(groupItems([])).toEqual([])
  })

  it('places a side row after its anchor and splits the agent group', () => {
    const entry = side('s1', 'a1')
    const rows = groupItems([user('u1'), assistant('a1'), assistant('a2')], [entry])
    expect(shape([user('u1'), assistant('a1'), assistant('a2')], [entry])).toEqual(['user:u1', 'agent:a1', 'side:s1', 'agent:a2'])
    expect(rows[2]).toMatchObject({ kind: 'side', thread: { id: 's1', root: entry } })
    expect(rows[3].key).toBe(agentKeyAfter(rows[2].key))
    expect(new Set(rows.map((r) => r.key)).size).toBe(4)
  })

  it('adds no chip row for a follow-up: the root row carries the whole thread', () => {
    const root = side('r', 'a1', 1)
    const follow = { ...side('f', 'a1', 2), thread: 'r' }
    const rows = groupItems([user('u1'), assistant('a1')], [follow, root])
    expect(shape([user('u1'), assistant('a1')], [follow, root])).toEqual(['user:u1', 'agent:a1', 'side:r'])
    const row = rows[2]
    expect(row.kind === 'side' && row.thread.entries.map((q) => q.id)).toEqual(['r', 'f'])
  })

  it('orders side rows sharing an anchor by askedAt', () => {
    expect(shape([user('u1'), assistant('a1')], [side('late', 'u1', 2), side('early', 'u1', 1)])).toEqual([
      'user:u1',
      'side:early',
      'side:late',
      'agent:a1'
    ])
  })

  it('puts after:null first only from the start, and drops unknown anchors', () => {
    const sides = [side('missing', 'hidden'), side('late', null, 2), side('early', null, 1), side('anchored', 'u1')]
    expect(shape([user('u1')], sides)).toEqual(['side:early', 'side:late', 'user:u1', 'side:anchored'])
    expect(shape([user('u1')], sides, false)).toEqual(['user:u1', 'side:anchored'])
    expect(shape([], sides)).toEqual(['side:early', 'side:late'])
    expect(shape([], sides, false)).toEqual([])
  })

  it('anchors a side row after a kept notice without bringing the notice back', () => {
    const kept: ChatItem = { type: 'notice', id: 'k1', kind: 'kept', text: 'Old edit.', ts: 0 }
    expect(shape([assistant('a1'), kept, assistant('a2')], [side('s1', 'k1')])).toEqual(['agent:a1', 'side:s1', 'agent:a2'])
  })
})

const blocks = (items: AgentItem[]): string[] =>
  foldTools(items).map((b) => (b.kind === 'tools' ? `tools:${b.tools.map((t) => t.id).join(',')}` : `item:${b.item.id}`))

describe('foldTools', () => {
  it('folds back-to-back tool calls into one block; text and approval cards end a run', () => {
    expect(blocks([assistant('a1'), tool('t1'), tool('t2'), approval('p1'), tool('t3'), assistant('a2')])).toEqual([
      'item:a1',
      'tools:t1,t2',
      'item:p1',
      'tools:t3',
      'item:a2'
    ])
  })

  it('keeps an ask tool call as its own block, never folded into a run', () => {
    const ask = { ...tool('ask1'), name: ASK_TOOL }
    expect(blocks([tool('t1'), ask, tool('t2')])).toEqual(['tools:t1', 'item:ask1', 'tools:t2'])
    expect(blocks([ask, tool('t1'), tool('t2')])).toEqual(['item:ask1', 'tools:t1,t2'])
  })

  it('keeps a side_question call as its own block like ask', () => {
    const side = { ...tool('side1'), name: ASK_SIDE_TOOL }
    expect(blocks([tool('t1'), side, tool('t2')])).toEqual(['tools:t1', 'item:side1', 'tools:t2'])
  })

  it('keeps a run keyed by its first tool while more tools join it', () => {
    expect(foldTools([tool('t1')])[0].key).toBe(foldTools([tool('t1'), tool('t2')])[0].key)
  })

  it('times a run from its first tool to the item after it', () => {
    expect(foldTools([tool('t1', 100), tool('t2', 200, 5000), assistant('a1', 900)])[0]).toMatchObject({ ms: 800 })
  })

  it('times a run that ends the group to its latest result', () => {
    expect(foldTools([assistant('a1', 50), tool('t1', 100, 400), tool('t2', 200, 300)])[1]).toMatchObject({ ms: 300 })
  })

  it('times a run saved without result times to its last tool start', () => {
    expect(foldTools([tool('t1', 100), tool('t2', 250)])[0]).toMatchObject({ ms: 150 })
  })
})

describe('thinking in runs', () => {
  it('folds thinking into the tool run around it, and a lone thought makes a run of its own', () => {
    expect(blocks([thinking('k1'), tool('t1'), thinking('k2'), tool('t2'), assistant('a1')])).toEqual(['tools:k1,t1,k2,t2', 'item:a1'])
    expect(blocks([thinking('k1'), assistant('a1'), thinking('k2')])).toEqual(['tools:k1', 'item:a1', 'tools:k2'])
    expect(blocks([tool('t1'), approval('p1'), thinking('k1')])).toEqual(['tools:t1', 'item:p1', 'tools:k1'])
  })

  it('times a run that starts with thinking from when the thinking began', () => {
    const b = foldTools([thinking('k1', 100, 900), tool('t1', 1000, 1500), assistant('a1', 3000)])[0]
    expect(b).toMatchObject({ kind: 'tools', ms: 2900 })
    expect(foldTools([thinking('k1', 100, 900)])[0]).toMatchObject({ kind: 'tools', ms: 800 })
  })

  it('a group that ends in thinking is still at work', () => {
    expect(endsInToolItems([assistant('a1'), thinking('k1')])).toBe(true)
    expect(endsInToolItems([thinking('k1'), assistant('a1')])).toBe(false)
  })

  it('previews a thought as one plain line: the latest paragraph live, the first once kept', () => {
    const text = '**Reading the spec**\n\nI am checking the parser.\n\n## Next\nThen the __store__.\n'
    expect(thoughtPreview(text)).toBe('Then the store.')
    expect(thoughtPreview(text, 'first')).toBe('Reading the spec')
    expect(thoughtPreview('')).toBe('')
    expect(thoughtPreview('  \n\n')).toBe('')
  })

  it('titles a kept thought by how long it took, when both ends were seen', () => {
    expect(thoughtTitle({ ts: 1000, doneTs: 13_400 })).toBe('Thought for 12s')
    expect(thoughtTitle({ ts: 1000 })).toBe('Thought')
    expect(thoughtTitle({ ts: 1000, doneTs: 1000 })).toBe('Thought')
  })
})

describe('endsInTools', () => {
  it('is true only when the last row is an agent group ending in a tool call', () => {
    expect(endsInTools(groupItems([user('u1'), assistant('a1'), tool('t1')]))).toBe(true)
    expect(endsInTools(groupItems([user('u1'), tool('t1'), assistant('a1')]))).toBe(false)
    expect(endsInTools(groupItems([tool('t1'), approval('p1')]))).toBe(false)
    expect(endsInTools(groupItems([tool('t1'), notice('n1')]))).toBe(false)
    expect(endsInTools([])).toBe(false)
  })

  it('is false for an ask that returned, true while it runs', () => {
    const ask = { ...tool('ask1'), name: ASK_TOOL }
    expect(endsInTools(groupItems([user('u1'), { ...ask, result: 'Looks fine.' }]))).toBe(false)
    expect(endsInTools(groupItems([user('u1'), { ...ask, result: 'Refused.', isError: true }]))).toBe(false)
    expect(endsInTools(groupItems([user('u1'), ask]))).toBe(true)
  })

  it('treats a side_question like an ask', () => {
    const side = { ...tool('side1'), name: ASK_SIDE_TOOL }
    expect(endsInTools(groupItems([user('u1'), { ...side, result: 'Yes.' }]))).toBe(false)
    expect(endsInTools(groupItems([user('u1'), side]))).toBe(true)
  })
})

describe('thoughtLabel', () => {
  it.each([
    [12_400, 'Thought for 12s'],
    [400, 'Thought for 1s'],
    [0, 'Thought for 1s'],
    [59_600, 'Thought for 1m'],
    [125_000, 'Thought for 2m 5s'],
    [120_000, 'Thought for 2m']
  ])('%i ms reads "%s"', (ms, label) => {
    expect(thoughtLabel(ms)).toBe(label)
  })
})

describe('groupItems authors', () => {
  const by = (agent: string, id: string): Extract<ChatItem, { type: 'assistant' }> => ({ ...assistant(id), agent })

  it('splits rows by author', () => {
    const rows = groupItems([by('ui', 'a1'), by('ui', 'a2'), by('wk', 'a3')])
    expect(rows.map((r) => (r.kind === 'agent' ? [r.agent, r.items.map((i) => i.id)] : null))).toEqual([
      ['ui', ['a1', 'a2']],
      ['wk', ['a3']]
    ])
  })

  it('gives null for single chat items', () => {
    const [row] = groupItems([assistant('a1')])
    expect(row.kind === 'agent' && row.agent).toBeNull()
  })
})

it('keeps browser handoff cards in their author group as a distinct item block', () => {
  const card: Extract<ChatItem, { type: 'browser-action' }> = {
    type: 'browser-action',
    id: 'card',
    ts: 1,
    agent: 'helper',
    handoff: {
      id: 'card',
      profileId: 'profile',
      generation: 'generation',
      chatId: 'chat',
      turnId: 'attempt',
      agent: 'helper',
      site: 'example.com',
      reason: 'Help',
      createdAt: 1,
      status: 'pending'
    }
  }
  const rows = groupItems([card])
  expect(rows[0]).toMatchObject({ kind: 'agent', agent: 'helper', items: [card] })
  expect(foldTools([card])).toEqual([{ kind: 'item', key: 'card', item: card }])
})

describe('rowIndexOf', () => {
  const rows = groupItems([user('u1'), assistant('a1'), tool('t1'), notice('n1'), assistant('a2')])

  it('finds the row of a user item, an item inside an agent group and a notice', () => {
    expect(rowIndexOf(rows, 'u1')).toBe(0)
    expect(rowIndexOf(rows, 'a1')).toBe(1)
    expect(rowIndexOf(rows, 't1')).toBe(1)
    expect(rowIndexOf(rows, 'n1')).toBe(2)
    expect(rowIndexOf(rows, 'a2')).toBe(3)
  })

  it('is -1 for an unknown id', () => {
    expect(rowIndexOf(rows, 'nope')).toBe(-1)
  })

  it('skips side rows while finding chat items', () => {
    const rows = groupItems([user('u1'), assistant('a1')], [side('s1', null), side('s2', 'u1')])
    expect(rowIndexOf(rows, 'u1')).toBe(1)
    expect(rowIndexOf(rows, 'a1')).toBe(3)
    expect(rowIndexOf(rows, 's1')).toBe(-1)
    expect(rowIndexOf(rows, 'nope')).toBe(-1)
  })
})

describe('lastContentRow', () => {
  it('skips side chips after the latest notice, so a paused notice keeps Continue', () => {
    const rows = groupItems([user('u1'), notice('n1')], [side('s1', 'n1')])
    expect(lastContentRow(rows)).toBe(1)
  })

  it('is the last row without trailing chips, and -1 with only chips', () => {
    expect(lastContentRow(groupItems([user('u1'), assistant('a1')]))).toBe(1)
    expect(lastContentRow(groupItems([], [side('s1', null)]))).toBe(-1)
  })
})

describe('withAcks', () => {
  const acked = (id: string, ack: string): ChatItem => ({ type: 'user', id, text: id, ts: 0, ack })
  it("puts the line on the agent group after its message", () => {
    const rows = withAcks(groupItems([acked('u1', 'On it.'), assistant('a1')]))
    expect(rows.map((r) => r.kind)).toEqual(['user', 'agent'])
    expect(rows[1]).toMatchObject({ kind: 'agent', ack: 'On it.', items: [{ id: 'a1' }] })
  })
  it("before the reply lands, gives the line a group under the key the reply's group will have", () => {
    const rows = withAcks(groupItems([user('u0'), assistant('a0'), acked('u1', 'On it.')]))
    expect(rows[3]).toEqual({ kind: 'agent', key: agentKeyAfter('u1'), items: [], agent: null, ack: 'On it.' })
    expect(groupItems([acked('u1', 'x'), assistant('a1')])[1].key).toBe(agentKeyAfter('u1'))
  })
  it('a message sent into the running reply gets its line after its bubble, inside the same turn', () => {
    const steer: ChatItem = { type: 'user', id: 's1', text: 'just unread', ts: 0, steered: true, ack: 'Got it.' }
    const rows = withAcks(groupItems([acked('u1', 'On it.'), tool('t1'), steer, assistant('a1')]))
    expect(rows.map((r) => r.kind)).toEqual(['user', 'agent', 'user', 'agent'])
    expect(rows[1]).toMatchObject({ ack: 'On it.', items: [{ id: 't1' }] })
    expect(rows[3]).toMatchObject({ ack: 'Got it.', items: [{ id: 'a1' }] })
  })
  it('leaves messages without a line alone', () => {
    const rows = groupItems([user('u1'), assistant('a1'), user('u2')])
    expect(withAcks(rows)).toEqual(rows)
  })
})
