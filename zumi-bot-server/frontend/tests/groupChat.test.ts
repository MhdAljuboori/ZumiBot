import { describe, expect, it } from 'vitest'
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import { engineCaps, type Engine, type EngineCaps } from '@zumibot/shared/engine'
import type { ActiveTurn, AgentSummary, ChatItem, ChatMeta, GroupInfo, QueueEntry } from '@zumibot/shared/types'
import {
  findAgent,
  isPassPrefix,
  liveActions,
  liveTail,
  liveTurns,
  memberAgents,
  memberOptions,
  membersLabel,
  mentionSegments,
  pausedAtEnd,
  queuedMembers,
  threadItems,
  toggleMember,
  workingMembers
} from '../src/state/groupChat'
import type { AgentItem } from '../src/state/messageGroups'

const agent = (name: string, extra: Partial<AgentSummary> = {}): AgentSummary => ({
  filePath: `/agents/${name}.md`,
  name,
  description: '',
  color: null,
  icon: null,
  error: null,
  builtIn: false,
  ...extra
})

const turn = (agent: string): ActiveTurn => ({ agent, turn: 't', since: 1 })
const entry = (agent: string, ...after: string[]): QueueEntry => ({ agent, after })

const group = (over: Partial<GroupInfo> = {}): GroupInfo => ({
  members: ['ui-ux', 'writer'],
  sessions: {},
  seen: {},
  role: '',
  active: [],
  queue: [],
  ...over
})

describe('findAgent', () => {
  it('prefers the valid agent when a broken duplicate shares the name', () => {
    const broken = agent('ui-ux', { filePath: '/agents/copy.md', error: 'Duplicate name' })
    const good = agent('ui-ux')
    expect(findAgent([broken, good], 'ui-ux')).toBe(good)
    expect(findAgent([broken], 'ui-ux')).toBe(broken)
    expect(findAgent([good], 'gone')).toBeUndefined()
  })
})

describe('memberAgents', () => {
  it('keeps member order and leaves out missing members', () => {
    const list = [agent('writer'), agent('ui-ux')]
    expect(memberAgents(['ui-ux', 'gone', 'writer'], list).map((a) => a.name)).toEqual(['ui-ux', 'writer'])
  })
})

describe('membersLabel', () => {
  it('counts the agents', () => {
    expect(membersLabel(3)).toBe('3 agents')
    expect(membersLabel(2)).toBe('2 agents')
    expect(membersLabel(1)).toBe('1 agent')
  })
})

describe('isPassPrefix', () => {
  it('hides a reply that is still only the pass marker', () => {
    for (const t of ['[', '[[', '[[PA', '[[PASS]]', ' [[PASS]] \n']) expect(isPassPrefix(t)).toBe(true)
  })
  it('shows anything else', () => {
    for (const t of ['[[PASS]] but', 'Hi', '[link]', '[[pass]]']) expect(isPassPrefix(t)).toBe(false)
  })
})

describe('mentionSegments', () => {
  it('splits member mentions like splitMentions', () => {
    expect(mentionSegments('hi @ui-ux and @nobody', ['ui-ux'])).toEqual([
      { kind: 'text', text: 'hi ' },
      { kind: 'mention', name: 'ui-ux', raw: '@ui-ux' },
      { kind: 'text', text: ' and @nobody' }
    ])
  })
  it('passes the everyone flag through, and leaves it in code', () => {
    expect(mentionSegments('@everyone `@everyone`', ['ui-ux'], true)).toEqual([
      { kind: 'mention', name: 'everyone', raw: '@everyone' },
      { kind: 'text', text: ' `@everyone`' }
    ])
    expect(mentionSegments('@everyone', ['ui-ux'])).toEqual([{ kind: 'text', text: '@everyone' }])
  })
  it('leaves handles inside code as text, keeping the original characters', () => {
    const text = 'run `@ui-ux` then\n```\n@writer\n```\n@Writer'
    expect(mentionSegments(text, ['ui-ux', 'writer'])).toEqual([
      { kind: 'text', text: 'run `@ui-ux` then\n```\n@writer\n```\n' },
      { kind: 'mention', name: 'writer', raw: '@Writer' }
    ])
  })
})

describe('memberOptions', () => {
  const cb = agent(ZUMI_BOT_NAME, { builtIn: true })
  const agents = [cb, agent('ui-ux'), agent('writer'), agent('qa'), agent('broken', { error: 'bad yaml' })]

  it('lists Zumi Bot disabled with "can\'t join" and leaves out agents that fail to load', () => {
    const opts = memberOptions(agents, [], false)
    expect(opts.map((o) => o.name)).toEqual([ZUMI_BOT_NAME, 'ui-ux', 'writer', 'qa'])
    expect(opts[0]).toMatchObject({ checked: false, disabled: true, note: "can't join" })
    expect(opts.slice(1).every((o) => !o.checked && !o.disabled && o.note === null)).toBe(true)
  })
  it('lists a Codex agent like any other while Codex rooms are on', () => {
    const opts = memberOptions([agent('cx', { provider: 'codex' }), agent('ui-ux')], ['ui-ux', 'cx'], false)
    expect(opts[0]).toMatchObject({ name: 'cx', checked: true, disabled: false, note: null })
    expect(opts[1]).toMatchObject({ name: 'ui-ux', checked: true, disabled: false, note: null })
  })
  it('with Codex rooms off, lists a Codex agent disabled with "can\'t join", like Zumi Bot', () => {
    const noRooms = (e: Engine): EngineCaps => ({ ...engineCaps(e), ...(e === 'codex' ? { rooms: false } : {}) })
    const opts = memberOptions([agent('cx', { provider: 'codex' }), agent('ui-ux')], ['ui-ux'], false, noRooms)
    expect(opts[0]).toMatchObject({ name: 'cx', checked: false, disabled: true, note: "can't join" })
    expect(opts[1]).toMatchObject({ name: 'ui-ux', checked: true, disabled: false, note: null })
  })
  it("an existing group's checklist locks unchecking when it would leave fewer than two members", () => {
    const two = memberOptions(agents, ['ui-ux', 'writer'], true)
    expect(two.filter((o) => o.checked).every((o) => o.disabled)).toBe(true)
    expect(two.find((o) => o.name === 'qa')).toMatchObject({ checked: false, disabled: false })
    const three = memberOptions(agents, ['ui-ux', 'writer', 'qa'], true)
    expect(three.filter((o) => o.checked).some((o) => o.disabled)).toBe(false)
  })
  it('the new-chat checklist never locks: Send already waits for two members', () => {
    const two = memberOptions(agents, ['ui-ux', 'writer'], false)
    expect(two.filter((o) => o.checked).map((o) => [o.name, o.disabled])).toEqual([
      ['ui-ux', false],
      ['writer', false]
    ])
    expect(memberOptions(agents, ['ui-ux'], false).find((o) => o.name === 'ui-ux')).toMatchObject({ checked: true, disabled: false })
    expect(memberOptions(agents, ['ui-ux', 'broken'], false)[4]).toMatchObject({ name: 'broken', checked: true, disabled: false })
  })
  it('keeps a member whose agent is gone, greyed as missing and uncheckable', () => {
    const opts = memberOptions(agents, ['ui-ux', 'writer', 'gone'], true)
    expect(opts[opts.length - 1]).toEqual({ name: 'gone', agent: undefined, checked: true, disabled: false, note: 'missing' })
  })
  it('keeps a member whose agent no longer loads, greyed without a note', () => {
    const opts = memberOptions(agents, ['ui-ux', 'broken'], true)
    expect(opts[opts.length - 1]).toMatchObject({ name: 'broken', checked: true, disabled: true, note: null })
  })
})

describe('toggleMember', () => {
  it('adds at the end and removes in place', () => {
    expect(toggleMember(['a', 'b'], 'c')).toEqual(['a', 'b', 'c'])
    expect(toggleMember(['a', 'b', 'c'], 'b')).toEqual(['a', 'c'])
  })
})

describe('live turns', () => {
  const asst = (id: string, turnId?: string, text = id): ChatItem => ({
    type: 'assistant',
    id,
    text,
    ts: 1,
    agent: 'ui-ux',
    ...(turnId ? { turn: turnId } : {})
  })
  const tool = (id: string, turnId: string, result: string | null, name = 'Bash'): ChatItem => ({
    type: 'tool',
    id,
    name,
    input: { command: 'ls' },
    result,
    isError: false,
    blocked: false,
    ts: 1,
    agent: 'ui-ux',
    turn: turnId
  })
  const approval = (id: string, turnId: string, status: 'pending' | 'denied' = 'pending', agentName = 'writer'): ChatItem => ({
    type: 'approval',
    id,
    toolUseId: null,
    toolName: 'Bash',
    input: {},
    description: null,
    reason: null,
    status,
    ts: 1,
    agent: agentName,
    turn: turnId
  })
  const ask = (id: string, turnId: string, status: 'pending' | 'answered'): ChatItem =>
    ({
      ...approval(id, turnId),
      toolName: 'AskUserQuestion',
      status,
      input: { questions: [{ question: 'Which?', header: 'H', options: [{ label: 'A', description: '' }] }] }
    }) as ChatItem
  const running = group({
    active: [
      { agent: 'ui-ux', turn: 't1', since: 0 },
      { agent: 'writer', turn: 't2', since: 0 }
    ]
  })
  const ids = (t: { items: ChatItem[] }) => t.items.map((i) => i.id)

  it('threadItems keeps only finished items, question and plan cards of a running turn included', () => {
    const plan: ChatItem = { ...approval('p1', 't1'), toolName: 'ExitPlanMode', input: { plan: '# P' } } as ChatItem
    const items = [asst('a'), asst('b', 't1'), ask('q1', 't1', 'pending'), plan, asst('c')]
    expect(threadItems(items).map((i) => i.id)).toEqual(['a', 'c'])
  })

  it('draws each running turn as one block in start order, however their items interleave', () => {
    const items = [asst('a'), approval('w1', 't2', 'denied'), tool('u1', 't1', 'ok'), asst('w2', 't2'), asst('u2', 't1'), asst('b')]
    const live = liveTurns(running, true, items)
    expect(live.map((t) => [t.agent, t.turn, t.active])).toEqual([
      ['ui-ux', 't1', true],
      ['writer', 't2', true]
    ])
    expect(live.map(ids)).toEqual([
      ['u1', 'u2'],
      ['w1', 'w2']
    ])
  })

  it("a running turn's thinking is in its block", () => {
    const thought: ChatItem = { type: 'thinking', id: 'k1', text: 'Checking', ts: 1, doneTs: 2, agent: 'ui-ux', turn: 't1' }
    const live = liveTurns(running, true, [thought, tool('u1', 't1', null)])
    expect(live.map(ids)).toEqual([['k1', 'u1'], []])
    expect(liveTail(live[0], '')).toMatchObject({ thinking: true, showWorking: false })
    expect(threadItems([thought]).map((i) => i.id)).toEqual([])
  })

  it('shows a member that has written nothing yet, and none outside a running room', () => {
    expect(liveTurns(running, true, []).map((t) => [t.agent, t.items.length, t.state])).toEqual([
      ['ui-ux', 0, 'working'],
      ['writer', 0, 'working']
    ])
    expect(liveTurns(running, false, [])).toEqual([])
    expect(liveTurns(undefined, true, [asst('x', 't1')])).toEqual([])
  })

  it('keeps a turn whose end has not landed yet after the working ones, inactive', () => {
    const g = group({ active: [{ agent: 'writer', turn: 't2', since: 0 }] })
    const live = liveTurns(g, true, [asst('u1', 't1'), asst('w1', 't2')])
    expect(live.map((t) => [t.agent, t.turn, t.active])).toEqual([
      ['writer', 't2', true],
      ['ui-ux', 't1', false]
    ])
  })

  it("leaves out a turn's notices, errors and pass reply", () => {
    const err: ChatItem = { type: 'error', id: 'e', text: 'boom', ts: 1, turn: 't1' }
    const live = liveTurns(running, true, [asst('u1', 't1'), err, asst('u2', 't1', ' [[PASS]] ')])
    expect(ids(live[0])).toEqual(['u1'])
  })

  it('reads what each turn waits on: a permission card, a question or plan card, or nothing', () => {
    const plan: ChatItem = { ...approval('p1', 't2'), toolName: 'ExitPlanMode', input: { plan: '# P' } } as ChatItem
    expect(liveTurns(running, true, [approval('r1', 't1', 'pending', 'ui-ux')])[0].state).toBe('approval')
    expect(liveTurns(running, true, [approval('r1', 't1', 'denied', 'ui-ux')])[0].state).toBe('working')
    expect(liveTurns(running, true, [ask('q1', 't2', 'pending')])[1].state).toBe('asked')
    expect(liveTurns(running, true, [ask('q1', 't2', 'answered')])[1].state).toBe('working')
    expect(liveTurns(running, true, [plan])[1].state).toBe('asked')
  })

  it('a member waiting on browser help or a vault card waits on approval', () => {
    const g = group({ active: [{ agent: 'writer', turn: 't', since: 0 }] })
    const help: ChatItem = {
      type: 'browser-action',
      id: 'b',
      ts: 1,
      agent: 'writer',
      turn: 't',
      handoff: {
        id: 'r',
        profileId: 'p',
        generation: 'g',
        chatId: 'c',
        turnId: 'attempt',
        site: 'https://example.test',
        reason: 'Sign in',
        createdAt: 1,
        agent: 'writer',
        status: 'pending'
      }
    }
    expect(liveTurns(g, true, [help])[0].state).toBe('approval')
    const vault: ChatItem = {
      type: 'vault-approval',
      id: 'v',
      ts: 1,
      agent: 'writer',
      turn: 't',
      request: {
        id: 'v',
        chatId: 'c',
        turnId: 'attempt',
        profileId: 'p',
        itemId: 'i',
        itemName: 'Work Visa',
        label: 'Visa •4242',
        site: 'shop.example.com',
        frameSite: 'shop.example.com',
        status: 'pending'
      }
    }
    expect(liveTurns(g, true, [vault])[0].state).toBe('approval')
    // Answered: the member is working again.
    expect(liveTurns(g, true, [{ ...vault, request: { ...vault.request, status: 'allowed' as const } }])[0].state).toBe('working')
  })

  it('carries a compacting member', () => {
    const g = group({ active: [{ agent: 'ui-ux', turn: 't1', since: 0, compacting: true }] })
    expect(liveTurns(g, true, [])[0].compacting).toBe(true)
  })
})

describe('liveTail', () => {
  const base = { items: [], state: 'working' as const, active: true, compacting: false }
  const runningTool: AgentItem = {
    type: 'tool',
    id: 'x',
    name: 'Bash',
    input: {},
    result: null,
    isError: false,
    blocked: false,
    ts: 1,
    turn: 't'
  }

  it('streams the live text, and hides one that so far reads as the pass marker', () => {
    expect(liveTail(base, 'Hello')).toEqual({ streaming: 'Hello', thinking: false, showWorking: false })
    expect(liveTail(base, '[[PA')).toEqual({ streaming: '', thinking: false, showWorking: true })
  })
  it('spins the tool run while tools are its latest output, else shows the working line', () => {
    expect(liveTail({ ...base, items: [runningTool] }, '')).toEqual({ streaming: '', thinking: true, showWorking: false })
    expect(liveTail(base, '')).toEqual({ streaming: '', thinking: false, showWorking: true })
    // Compacting gets the line, which says so.
    expect(liveTail({ ...base, items: [runningTool], compacting: true }, '')).toEqual({ streaming: '', thinking: false, showWorking: true })
  })
  it('shows neither while the member waits on the user, nor for a turn that ended', () => {
    expect(liveTail({ ...base, state: 'approval' }, '')).toEqual({ streaming: '', thinking: false, showWorking: false })
    expect(liveTail({ ...base, active: false }, 'late')).toEqual({ streaming: '', thinking: false, showWorking: false })
  })
})

describe('queuedMembers', () => {
  const agents = [agent('ui-ux'), agent('writer'), agent('dev')]
  it('lists queued members not working yet, with whom each waits for', () => {
    const g = group({
      active: [{ agent: 'ui-ux', turn: 't1', since: 0 }],
      queue: [entry('ui-ux', 'writer'), entry('dev', 'ui-ux', 'ghost'), entry('writer', 'writer')]
    })
    expect(queuedMembers(g, agents)).toEqual([
      { agent: 'dev', text: 'waits for Ui Ux, ghost' },
      { agent: 'writer', text: 'up next' } // a self-wait is not listed
    ])
  })
})

describe('pausedAtEnd', () => {
  const notice = (id: string, kind: 'paused' | 'stopped'): ChatItem => ({ type: 'notice', id, kind, text: kind, ts: 1 })
  const user = (id: string): ChatItem => ({ type: 'user', id, text: id, ts: 1 })

  it('is true only when the last item is the paused notice', () => {
    expect(pausedAtEnd([user('u'), notice('n', 'paused')])).toBe(true)
    expect(pausedAtEnd([notice('n', 'paused'), user('u')])).toBe(false) // the user wrote since
    expect(pausedAtEnd([user('u'), notice('n', 'stopped')])).toBe(false)
    expect(pausedAtEnd([])).toBe(false)
  })
})

describe('workingMembers', () => {
  it('lists the active agents of a running group', () => {
    const g = group({ active: [turn('a'), turn('b')] })
    expect(workingMembers({ inFlight: true, group: g })).toEqual(['a', 'b'])
    expect(workingMembers({ inFlight: false, group: g })).toEqual([])
    expect(workingMembers({ inFlight: true })).toEqual([])
  })
})

describe('liveActions', () => {
  const handlers = {
    onReply: () => {},
    resendOf: (id: string) => `user-before-${id}`,
    onFork: () => {}
  }

  it('keeps reply and the rest, but drops Fork and Resend on a message its running turn still holds', () => {
    const live = liveActions(handlers)
    expect(live.onReply).toBe(handlers.onReply)
    expect('onFork' in live).toBe(false)
    expect(live.resendOf('a1')).toBeNull()
  })

  it('leaves the handlers it was given alone', () => {
    liveActions(handlers)
    expect(handlers.onFork).toBeTypeOf('function')
    expect(handlers.resendOf('a1')).toBe('user-before-a1')
  })
})
