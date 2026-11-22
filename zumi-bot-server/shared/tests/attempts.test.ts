import { describe, expect, it } from 'vitest'
import {
  NO_PICKS,
  attemptLabel,
  attemptState,
  attemptTitle,
  attemptTone,
  attemptsLine,
  costLine,
  picksError,
  startBlocked,
  type AttemptChat
} from '@zumibot/shared/attempts'
import {
  ATTEMPTS_MAX,
  ATTEMPTS_MIN,
  attemptOf,
  attemptsRunning,
  dropAttempts,
  emptyTodos,
  keepAttempt,
  startAttempts,
  statusOf,
  type TodoAttempts,
  type TodoFile,
  type TodoItem
} from '@zumibot/shared/todos'

const chat = (o: Partial<AttemptChat> = {}): AttemptChat => ({ id: 'c1', inFlight: false, ...o }) as AttemptChat

describe('attemptState', () => {
  it('says what the chat is doing, with a pause and a usage limit read before anything else', () => {
    // A paused turn's CLI is still up, so inFlight alone would read as working.
    expect(attemptState(chat({ inFlight: true, pause: { at: 1 } as never }), 0)).toBe('paused')
    expect(attemptState(chat({ resume: { at: 1 } as never }), 0)).toBe('limited')
    // An approval card beats running for the same reason the board's column does: the turn waits on the user.
    expect(attemptState(chat({ inFlight: true }), 2)).toBe('waiting')
    expect(attemptState(chat({ inFlight: true }), 0)).toBe('running')
    expect(attemptState(undefined, 0)).toBe('gone')
  })

  it('reads a finished attempt from the outcome its turn stored', () => {
    const with_ = (outcome?: 'ok' | 'error' | 'stopped') =>
      chat({ attempt: { todoId: 't', setId: 's', n: 1, ...(outcome ? { outcome } : {}) } })
    expect(attemptState(with_(), 0)).toBe('starting')
    expect(attemptState(with_('ok'), 0)).toBe('done')
    expect(attemptState(with_('error'), 0)).toBe('failed')
    expect(attemptState(with_('stopped'), 0)).toBe('stopped')
  })
})

describe('attemptLabel and attemptTone', () => {
  it('says a cap pause in its own words', () => {
    expect(attemptLabel('paused', chat())).toBe('Paused')
    expect(attemptLabel('paused', chat({ pauseCap: { scope: { kind: 'agent' } } as never }))).toBe('Paused at a spend cap')
    expect(attemptLabel('limited')).toBe('Waiting for the usage limit')
    expect(attemptLabel('waiting')).toBe('Needs approval')
    expect(attemptLabel('gone')).toBe('Chat deleted')
  })

  it('draws a finished attempt, one that waits on the user and one still working apart', () => {
    expect(attemptTone('waiting')).toBe('you')
    expect(attemptTone('done')).toBe('done')
    expect(attemptTone('running')).toBe('busy')
    expect(attemptTone('failed')).toBe('quiet')
  })
})

describe('picksError', () => {
  const agents = [
    { name: 'alpha', error: null },
    { name: 'beta', error: null },
    { name: 'broken', error: 'bad frontmatter' }
  ]
  it('takes two to five picks, the same agent twice included', () => {
    expect(picksError([{ agent: 'alpha' }, { agent: 'alpha' }], agents)).toBeNull()
    expect(picksError([{ agent: 'alpha' }], agents)).toBe(NO_PICKS)
    expect(
      picksError(
        Array.from({ length: ATTEMPTS_MAX + 1 }, () => ({ agent: 'alpha' })),
        agents
      )
    ).toBe(NO_PICKS)
    expect(ATTEMPTS_MIN).toBe(2)
  })

  it('names an agent that is not there or cannot load', () => {
    expect(picksError([{ agent: 'alpha' }, { agent: 'nope' }], agents)).toBe('No agent named nope')
    expect(picksError([{ agent: 'alpha' }, { agent: 'broken' }], agents)).toBe('broken cannot load: fix its file first')
  })
})

describe('the words over the rows', () => {
  it('counts what is done and what a set costs', () => {
    expect(attemptsLine(['done', 'running', 'done'])).toBe('2 of 3 done')
    expect(costLine(5)).toContain('5× the cost of one')
    expect(attemptTitle('Fix the sum', { agent: 'alpha', n: 2 })).toBe('Fix the sum · alpha #2')
  })
})

// ---------- the card's own record ----------

const item = (o: Partial<TodoItem> = {}): TodoItem => ({
  id: 'i1',
  text: 'Fix the sum',
  group: null,
  from: { chatId: null, turn: 'user', itemId: null, label: 'x', at: 1 },
  addedBy: 'user',
  done: null,
  removed: null,
  last: { action: 'added', by: 'user', at: 1 },
  rev: 1,
  updatedAt: 1,
  ...o
})
const file = (i: TodoItem): TodoFile => ({ ...emptyTodos(), rev: 1, items: [i] })
const set = (o: Partial<TodoAttempts> = {}): TodoAttempts => ({
  id: 's1',
  at: 10,
  base: 'abc',
  folder: '/repo',
  prompt: 'Fix the sum',
  attempts: [
    { n: 1, agent: 'alpha', engine: 'claude', chatId: 'chat-a' },
    { n: 2, agent: 'beta', engine: 'codex', chatId: 'chat-b' }
  ],
  ...o
})

describe('startAttempts', () => {
  it('puts the set on the card and moves it to In progress', () => {
    const r = startAttempts(file(item()), 'i1', set(), 20)
    expect(statusOf(r.item)).toBe('progress')
    expect(r.item.attempts?.attempts).toHaveLength(2)
    expect(attemptsRunning(r.item)).toBe(true)
    expect(attemptOf(r.item, 'chat-b')?.agent).toBe('beta')
    expect(attemptOf(r.item, 'nope')).toBeUndefined()
    // A set is another chat's work, not news for the board's agents: the rev does not move.
    expect(r.file.rev).toBe(1)
  })

  it('refuses a done card, one an agent already has, and a second set', () => {
    expect(() => startAttempts(file(item({ done: { at: 1, by: 'user' } })), 'i1', set(), 20)).toThrow(/done/i)
    const taken = item({ assignee: 'alpha', task: { agent: 'alpha', chatId: 'c', at: 1, review: null } })
    expect(() => startAttempts(file(taken), 'i1', set(), 20)).toThrow(/already working/i)
    const running = startAttempts(file(item()), 'i1', set(), 20)
    expect(() => startAttempts(running.file, 'i1', set({ id: 's2' }), 30)).toThrow(/already has attempts/i)
    expect(startBlocked(running.item)).toMatch(/already has attempts/i)
    expect(startBlocked(item())).toBeNull()
  })
})

describe('keepAttempt', () => {
  it('gives the card to the winner, links its chat, moves to In review and names the others', () => {
    const started = startAttempts(file(item()), 'i1', set(), 20)
    const r = keepAttempt(started.file, 'i1', 'chat-b', 30)
    expect(r.item.assignee).toBe('beta')
    expect(r.item.folder).toBe('/repo')
    expect(r.item.task).toEqual({ agent: 'beta', chatId: 'chat-b', at: 30, review: null })
    expect(statusOf(r.item)).toBe('review')
    expect(r.item.attempts?.winner).toBe('chat-b')
    expect(r.kept.agent).toBe('beta')
    expect(r.others.map((a) => a.chatId)).toEqual(['chat-a'])
    expect(attemptsRunning(r.item)).toBe(false)
  })

  it('refuses a chat that is not one of the attempts, a card with none, and a second keep', () => {
    const started = startAttempts(file(item()), 'i1', set(), 20)
    expect(() => keepAttempt(started.file, 'i1', 'chat-z', 30)).toThrow(/not one of/i)
    expect(() => keepAttempt(file(item()), 'i1', 'chat-a', 30)).toThrow(/no attempts/i)
    const kept = keepAttempt(started.file, 'i1', 'chat-a', 30)
    expect(() => keepAttempt(kept.file, 'i1', 'chat-b', 40)).toThrow(/already kept/i)
  })
})

describe('dropAttempts', () => {
  it('takes the set off the card, back to New, and names the chats it left alone', () => {
    const started = startAttempts(file(item()), 'i1', set(), 20)
    const r = dropAttempts(started.file, 'i1', 30)
    expect(r.item.attempts).toBeUndefined()
    expect(statusOf(r.item)).toBe('new')
    expect(r.dropped.map((a) => a.chatId)).toEqual(['chat-a', 'chat-b'])
    expect(() => dropAttempts(r.file, 'i1', 40)).toThrow(/no attempts running/i)
  })

  it("refuses once one was kept, since that one is the card's task now", () => {
    const started = startAttempts(file(item()), 'i1', set(), 20)
    const kept = keepAttempt(started.file, 'i1', 'chat-a', 30)
    expect(() => dropAttempts(kept.file, 'i1', 40)).toThrow(/no attempts running/i)
  })
})
