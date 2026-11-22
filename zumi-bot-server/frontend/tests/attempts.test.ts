import { describe, expect, it } from 'vitest'
import type { AgentSummary, ChatMeta, GitChanges } from '@zumibot/shared/types'
import type { TodoAttempts, TodoItem } from '@zumibot/shared/todos'
import {
  addPick,
  attemptRows,
  canAddPick,
  canCompare,
  canDropPick,
  changesLabel,
  defaultPicks,
  dropPick,
  durationLabel,
  folderLine,
  setPick,
  togglePick
} from '../src/state/attempts'

const set = (o: Partial<TodoAttempts> = {}): TodoAttempts => ({
  id: 's1',
  at: 1_000,
  base: 'abc',
  folder: '/repo',
  prompt: 'Fix it',
  attempts: [
    { n: 1, agent: 'alpha', engine: 'claude', chatId: 'a' },
    { n: 2, agent: 'beta', engine: 'codex', chatId: 'b' }
  ],
  ...o
})
const item = (o: Partial<TodoItem> = {}): TodoItem => ({
  id: 'i1',
  text: 'Fix it',
  group: null,
  from: { chatId: null, turn: 'u', itemId: null, label: 'x', at: 1 },
  addedBy: 'user',
  done: null,
  removed: null,
  last: { action: 'added', by: 'user', at: 1 },
  rev: 1,
  updatedAt: 1,
  attempts: set(),
  ...o
})
const chat = (o: Partial<ChatMeta>): ChatMeta => o as ChatMeta
const agent = (name: string, o: Partial<AgentSummary> = {}): AgentSummary => ({
  name,
  filePath: `/a/${name}.md`,
  description: '',
  color: null,
  icon: null,
  error: null,
  builtIn: false,
  ...o
})

describe('attemptRows', () => {
  it('pairs each attempt with its chat and what that chat is doing', () => {
    const rows = attemptRows(
      item(),
      [chat({ id: 'a', inFlight: true }), chat({ id: 'b', attempt: { todoId: 'i1', setId: 's1', n: 2, outcome: 'ok' } })],
      {}
    )
    expect(rows.map((r) => [r.attempt.agent, r.state, r.label])).toEqual([
      ['alpha', 'running', 'Working…'],
      ['beta', 'done', 'Done']
    ])
    expect(rows.every((r) => !r.winner)).toBe(true)
  })

  it('marks the kept one and reads a deleted chat as gone', () => {
    const rows = attemptRows(item({ attempts: set({ winner: 'b' }) }), [chat({ id: 'b' })], {})
    expect(rows[0].state).toBe('gone')
    expect(rows[1].winner).toBe(true)
  })

  it('is empty for a card with no set', () => {
    expect(attemptRows(item({ attempts: undefined }), [], {})).toEqual([])
  })
})

describe('changesLabel', () => {
  const changes = (files: { added: number | null; removed: number | null }[], more = 0): GitChanges => ({
    top: '/r',
    branch: 'main',
    head: 'abc',
    more,
    files: files.map((f, i) => ({ path: `f${i}.ts`, kind: 'modified', staged: false, ...f }))
  })

  it('counts the files and the lines, and says when there is nothing yet', () => {
    expect(
      changesLabel(
        changes([
          { added: 10, removed: 2 },
          { added: 30, removed: 10 }
        ])
      )
    ).toBe('2 files · +40 −12')
    expect(changesLabel(changes([{ added: 3, removed: 0 }]))).toBe('1 file · +3')
    expect(changesLabel(changes([]))).toBe('nothing yet')
    expect(changesLabel(changes([{ added: null, removed: null }]))).toBe('1 file')
  })

  it('counts the files past the cap too, and says what it does not know', () => {
    expect(changesLabel(changes([{ added: 1, removed: 0 }], 4))).toBe('5 files · +1')
    expect(changesLabel(undefined)).toBe('…')
    expect(changesLabel(null)).toBe('no diff')
  })
})

describe('durationLabel', () => {
  it('runs to now while the turn is up, and stops at the last reply once it is not', () => {
    const at = 1_000_000
    expect(durationLabel(at, chat({ id: 'a', inFlight: true }), at + 5 * 60_000)).toBe('5m')
    expect(durationLabel(at, chat({ id: 'a', inFlight: false, replyAt: at + 2 * 60_000 }), at + 60 * 60_000)).toBe('2m')
    // A reply stamped before the set started (a clock step) must not read as a negative age.
    expect(durationLabel(at, chat({ id: 'a', inFlight: false, replyAt: at - 9_000 }), at)).toBe('now')
  })
})

describe('the compare ticks', () => {
  it('takes two, and a third moves the pair rather than refusing', () => {
    expect(canCompare(['a'])).toBe(false)
    expect(canCompare(['a', 'b'])).toBe(true)
    expect(togglePick([], 'a')).toEqual(['a'])
    expect(togglePick(['a'], 'a')).toEqual([])
    expect(togglePick(['a', 'b'], 'c')).toEqual(['b', 'c'])
  })
})

describe('the dialog picks', () => {
  const agents = [agent('alpha'), agent('beta'), agent('gamma')]

  it("starts on two, the card's own agent first when it has one", () => {
    expect(defaultPicks(agents, undefined)).toEqual(['alpha', 'beta'])
    expect(defaultPicks(agents, 'gamma')).toEqual(['gamma', 'alpha'])
    expect(defaultPicks(agents, 'user')).toEqual(['alpha', 'beta'])
    expect(defaultPicks([], undefined)).toEqual([])
  })

  it('adds up to five and never goes below two', () => {
    let picks = ['alpha', 'beta']
    expect(canDropPick(picks)).toBe(false)
    picks = addPick(picks, agents)
    expect(picks).toEqual(['alpha', 'beta', 'gamma'])
    expect(canDropPick(picks)).toBe(true)
    // Out of fresh names it repeats the last: the same agent twice is a fair second try.
    picks = addPick(picks, agents)
    expect(picks).toEqual(['alpha', 'beta', 'gamma', 'gamma'])
    picks = addPick(picks, agents)
    expect(canAddPick(picks)).toBe(false)
    expect(addPick(picks, agents)).toHaveLength(5)
    expect(dropPick(picks, 0)).toHaveLength(4)
    expect(dropPick(['alpha', 'beta'], 0)).toEqual(['alpha', 'beta'])
    expect(setPick(['alpha', 'beta'], 1, 'gamma')).toEqual(['alpha', 'gamma'])
  })
})

describe('folderLine', () => {
  it('says what happens, and what to do when the folder does not isolate', () => {
    expect(folderLine(undefined, true)).toMatch(/Pick the folder/)
    expect(folderLine('/repo', undefined)).toContain('its own worktree beside /repo')
    expect(folderLine('/repo', true)).toContain('from the commit it is on now')
    expect(folderLine('/repo', false)).toContain('Isolate in worktree')
  })
})
