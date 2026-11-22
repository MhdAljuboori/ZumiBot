import { describe, expect, it } from 'vitest'
import { planQueue, readyEntries, type ModeratorPick, type PlanInput } from '../../src/core/chat/groupQueue'

const base: PlanInput = {
  answer: { next: [], drop: [], skip: [], askUser: false },
  mentioned: [],
  speaker: null,
  queue: [],
  working: [],
  unrouted: [],
  available: ['ui', 'wk', 'ps'],
  lastAgent: null,
  everyone: false
}
const pick = (agent: string, after: string[] = [], note: string | null = null): ModeratorPick => ({ agent, after, note })
const ans = (next: ModeratorPick[], drop: string[] = [], skip: string[] = []) => ({ next, drop, skip, askUser: false })

describe('planQueue', () => {
  it('starts mentioned members together by default', () => {
    const p = planQueue({ ...base, speaker: 'ps', answer: ans([pick('ui'), pick('wk')]), mentioned: ['ui', 'wk'] })
    expect(p.queue).toEqual([
      { agent: 'ui', after: [] },
      { agent: 'wk', after: [] }
    ])
  })

  it("keeps the moderator's waits", () => {
    const p = planQueue({ ...base, answer: ans([pick('ui'), pick('wk', ['ui'])]) })
    expect(p.queue).toEqual([
      { agent: 'ui', after: [] },
      { agent: 'wk', after: ['ui'] }
    ])
  })

  it('adds a left-out mention waiting for everyone busy', () => {
    const p = planQueue({
      ...base,
      speaker: null,
      working: ['ps'],
      queue: [{ agent: 'ui', after: [] }],
      answer: ans([]),
      mentioned: ['wk']
    })
    expect(p.queue.find((e) => e.agent === 'wk')).toEqual({ agent: 'wk', after: ['ps', 'ui'] })
  })

  it('a mention wins over drop', () => {
    const p = planQueue({ ...base, queue: [{ agent: 'ui', after: [] }], answer: ans([], ['ui']), mentioned: ['ui'] })
    expect(p.queue.map((e) => e.agent)).toEqual(['ui'])
  })

  it('a member message does not queue a mention the moderator skips', () => {
    const p = planQueue({ ...base, speaker: 'ps', answer: ans([], [], ['ui']), mentioned: ['ui', 'wk'] })
    expect(p.queue.map((e) => e.agent)).toEqual(['wk'])
    expect(p.added).toEqual(['wk'])
  })

  it('next wins over skip', () => {
    const p = planQueue({ ...base, speaker: 'ps', answer: ans([pick('ui')], [], ['ui']), mentioned: ['ui'] })
    expect(p.queue.map((e) => e.agent)).toEqual(['ui'])
  })

  it('a user message ignores skip', () => {
    const p = planQueue({ ...base, speaker: null, answer: ans([], [], ['ui']), mentioned: ['ui'] })
    expect(p.queue.map((e) => e.agent)).toEqual(['ui'])
  })

  it('a failed moderator queues every mention', () => {
    const p = planQueue({ ...base, speaker: 'ps', answer: null, mentioned: ['ui', 'wk'] })
    expect(p.queue.map((e) => e.agent)).toEqual(['ui', 'wk'])
  })

  it('a skipped mention that is queued and in drop is dropped', () => {
    const p = planQueue({
      ...base,
      speaker: 'ps',
      queue: [{ agent: 'ui', after: [] }],
      answer: ans([], ['ui'], ['ui']),
      mentioned: ['ui']
    })
    expect(p.queue).toEqual([])
  })

  it('drop removes a queued member and the waits on it', () => {
    const p = planQueue({
      ...base,
      speaker: 'ps',
      queue: [
        { agent: 'ui', after: [] },
        { agent: 'wk', after: ['ui'] }
      ],
      answer: ans([], ['ui'])
    })
    expect(p.queue).toEqual([{ agent: 'wk', after: [] }])
  })

  it('drop ignores members that are not queued', () => {
    const p = planQueue({ ...base, speaker: 'ps', queue: [{ agent: 'ui', after: [] }], answer: ans([], ['wk', 'gone']) })
    expect(p.queue).toEqual([{ agent: 'ui', after: [] }])
  })

  it('a queued member keeps its place and gains the new waits', () => {
    const p = planQueue({
      ...base,
      speaker: 'ps',
      queue: [
        { agent: 'ui', after: ['wk'] },
        { agent: 'wk', after: [] }
      ],
      answer: ans([pick('ui', ['ps'])]),
      working: ['ps']
    })
    expect(p.queue[0]).toEqual({ agent: 'ui', after: ['wk', 'ps'] })
    expect(p.queue.map((e) => e.agent)).toEqual(['ui', 'wk'])
  })

  it('a member picked while working waits for itself', () => {
    const p = planQueue({ ...base, working: ['ui'], answer: ans([pick('ui')]) })
    expect(p.queue).toEqual([{ agent: 'ui', after: ['ui'] }])
    // a member that is not working may never wait for itself
    const q = planQueue({ ...base, answer: ans([pick('ui', ['ui'])]) })
    expect(q.queue).toEqual([{ agent: 'ui', after: [] }])
  })

  it("breaks a wait loop by dropping the later entry's wait", () => {
    const p = planQueue({ ...base, answer: ans([pick('ui', ['wk']), pick('wk', ['ui'])]) })
    expect(p.queue).toEqual([
      { agent: 'ui', after: ['wk'] },
      { agent: 'wk', after: [] }
    ])
  })

  it('breaks a loop through a third member', () => {
    const p = planQueue({ ...base, answer: ans([pick('ui', ['wk']), pick('wk', ['ps']), pick('ps', ['ui'])]) })
    expect(p.queue).toEqual([
      { agent: 'ui', after: ['wk'] },
      { agent: 'wk', after: ['ps'] },
      { agent: 'ps', after: [] }
    ])
  })

  it('drops waits on members that are neither working, queued nor picked', () => {
    const p = planQueue({ ...base, answer: ans([pick('ui', ['wk', 'ps'])]), working: ['ps'] })
    expect(p.queue).toEqual([{ agent: 'ui', after: ['ps'] }])
  })

  it('keeps waits on members whose reply is not routed yet, and makes every fallback wait for them', () => {
    // ui finished while the moderator ran: its reply waits in the inbox
    const picked = planQueue({ ...base, speaker: 'ps', unrouted: ['ui'], answer: ans([pick('wk', ['ui'])]) })
    expect(picked.queue).toEqual([{ agent: 'wk', after: ['ui'] }])
    const leftOut = planQueue({ ...base, working: ['ps'], unrouted: ['ui'], answer: ans([]), mentioned: ['wk'] })
    expect(leftOut.queue).toEqual([{ agent: 'wk', after: ['ps', 'ui'] }])
    const failed = planQueue({ ...base, answer: null, unrouted: ['ps'], mentioned: ['ui', 'wk'] })
    expect(failed.queue).toEqual([
      { agent: 'ui', after: ['ps'] },
      { agent: 'wk', after: ['ui'] }
    ])
    const answerer = planQueue({ ...base, answer: null, unrouted: ['wk'], lastAgent: 'ui' })
    expect(answerer.queue).toEqual([{ agent: 'ui', after: ['wk'] }])
  })

  it('drops picks of unavailable members', () => {
    const p = planQueue({ ...base, answer: ans([pick('gone'), pick('ui')]) })
    expect(p.queue.map((e) => e.agent)).toEqual(['ui'])
  })

  it('the speaker comes back only when it waits for someone', () => {
    const none = planQueue({ ...base, speaker: 'wk', answer: ans([pick('wk')]) })
    expect(none.queue).toEqual([])
    const waits = planQueue({ ...base, speaker: 'wk', answer: ans([pick('ui'), pick('wk', ['ui'])]) })
    expect(waits.queue).toEqual([
      { agent: 'ui', after: [] },
      { agent: 'wk', after: ['ui'] }
    ])
  })

  it('a failed moderator runs the mentioned in order after everyone busy', () => {
    const p = planQueue({ ...base, answer: null, working: ['ps'], mentioned: ['ui', 'wk'] })
    expect(p.queue).toEqual([
      { agent: 'ui', after: ['ps'] },
      { agent: 'wk', after: ['ui'] }
    ])
    expect(p.notice).toBe("Couldn't check who else should reply.")
  })

  it('a failed moderator on an unmentioned user message names who answers', () => {
    const p = planQueue({ ...base, answer: null, working: ['ps'], lastAgent: 'ui' })
    expect(p.queue).toEqual([{ agent: 'ui', after: ['ps'] }])
    expect(p.notice).toBe("Couldn't check who else should reply, so Ui answers.")
  })

  it('an unmentioned user message always gets an answer, skipping the queued', () => {
    const a = planQueue({ ...base, queue: [{ agent: 'ui', after: [] }], lastAgent: 'ui' })
    expect(a.added).toEqual(['wk'])
    expect(a.queue.find((e) => e.agent === 'wk')).toEqual({ agent: 'wk', after: ['ui'] })
    expect(a.notice).toBeNull()
  })

  it('an agent message may end the conversation', () => {
    const p = planQueue({ ...base, speaker: 'wk' })
    expect(p).toEqual({ queue: [], added: [], notes: {}, notice: null })
  })

  it('notes reach the picked members', () => {
    const p = planQueue({ ...base, answer: ans([pick('ui', [], 'discuss'), pick('wk')]) })
    expect(p.notes).toEqual({ ui: 'discuss' })
  })

  it('added lists only newly queued members', () => {
    const p = planQueue({ ...base, speaker: 'ps', queue: [{ agent: 'ui', after: [] }], answer: ans([pick('ui'), pick('wk')]) })
    expect(p.added).toEqual(['wk'])
  })
})

describe('readyEntries', () => {
  const none = new Set<string>()
  it('an entry with no waits is ready', () => {
    const q = [{ agent: 'ui', after: [] }]
    expect(readyEntries(q, none, none)).toEqual(q)
  })

  it('waits for a working member', () => {
    const q = [{ agent: 'ui', after: ['wk'] }]
    expect(readyEntries(q, new Set(['wk']), none)).toEqual([])
    expect(readyEntries(q, none, none)).toEqual(q)
  })

  it('waits for a member queued behind it', () => {
    const q = [
      { agent: 'ui', after: ['wk'] },
      { agent: 'wk', after: [] }
    ]
    expect(readyEntries(q, none, none)).toEqual([q[1]])
  })

  it('waits for a reply the moderator has not routed', () => {
    const q = [{ agent: 'ui', after: ['wk'] }]
    expect(readyEntries(q, none, new Set(['wk']))).toEqual([])
  })

  it('a working member is never ready', () => {
    const q = [{ agent: 'ui', after: [] }]
    expect(readyEntries(q, new Set(['ui']), none)).toEqual([])
  })

  it('a self-wait clears when its turn ends', () => {
    const q = [{ agent: 'ui', after: ['ui'] }]
    expect(readyEntries(q, new Set(['ui']), none)).toEqual([])
    expect(readyEntries(q, none, none)).toEqual(q)
  })
})

describe('planQueue with @everyone', () => {
  const ev = { ...base, everyone: true }

  it('queues only the moderator picks, plus members mentioned by name', () => {
    const p = planQueue({ ...ev, answer: ans([pick('wk'), pick('ui', ['wk'])]) })
    expect(p.queue).toEqual([
      { agent: 'wk', after: [] },
      { agent: 'ui', after: ['wk'] }
    ])
    const q = planQueue({ ...ev, answer: ans([pick('wk')]), mentioned: ['ps'] })
    expect(q.queue.map((e) => e.agent)).toEqual(['wk', 'ps'])
  })

  it('with no picks queues every available member side by side after busy', () => {
    const p = planQueue({ ...ev, working: ['ps'], speaker: null, available: ['ui', 'wk', 'ps'], answer: ans([]) })
    expect(p.queue).toEqual([
      { agent: 'ui', after: ['ps'] },
      { agent: 'wk', after: ['ps'] },
      { agent: 'ps', after: ['ps'] }
    ])
    expect(p.added).toEqual(['ui', 'wk', 'ps'])
    expect(p.notice).toBeNull()
  })

  it('with no picks leaves out the speaker', () => {
    const p = planQueue({ ...ev, speaker: 'ui', answer: ans([]) })
    expect(p.queue.map((e) => e.agent)).toEqual(['wk', 'ps'])
  })

  it('a failed moderator runs every member one after another, with the notice', () => {
    const p = planQueue({ ...ev, working: ['x'], answer: null, mentioned: ['wk'] })
    expect(p.queue).toEqual([
      { agent: 'ui', after: ['x'] },
      { agent: 'wk', after: ['ui'] },
      { agent: 'ps', after: ['wk'] }
    ])
    expect(p.notice).toBe("Couldn't check who else should reply.")
  })

  it('does not use the no-mention fallback answerer', () => {
    const p = planQueue({ ...ev, answer: ans([]), lastAgent: 'wk' })
    expect(p.queue).toHaveLength(3)
    expect(p.notice).toBeNull()
  })
  it('a moderator pick already in the queue counts, so nobody else is added', () => {
    const p = planQueue({ ...ev, queue: [{ agent: 'wk', after: ['ps'] }], working: ['ps'], answer: ans([pick('wk')]) })
    expect(p.queue.map((e) => e.agent)).toEqual(['wk'])
    expect(p.added).toEqual([])
  })

  it('a named mention and no picks queues the named member plus everyone else, side by side', () => {
    const p = planQueue({ ...ev, answer: ans([]), mentioned: ['wk'] })
    expect(p.queue).toEqual([
      { agent: 'wk', after: [] },
      { agent: 'ui', after: [] },
      { agent: 'ps', after: [] }
    ])
  })
})
