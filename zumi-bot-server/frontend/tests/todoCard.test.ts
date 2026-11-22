import { describe, expect, it } from 'vitest'
import { addTodos, askTodo, assignTodo, emptyTodos, reviewTodo, startTask, type TodoItem } from '@zumibot/shared/todos'
import type { AgentSummary } from '@zumibot/shared/types'
import {
  quickFolder,
  ASSIGN_ME,
  ASSIGN_NOBODY,
  STATE_LABEL,
  answersToSend,
  assignValue,
  assigneeOf,
  cardHints,
  cardState,
  givableAgents,
  giveFolder,
  statusTone
} from '../src/state/todoCard'

let n = 0
const newId = () => `x${++n}`
const card = (): TodoItem[] => {
  let f = addTodos(
    emptyTodos(),
    [{ text: 'Ship it', description: 'notes' }],
    'user',
    { chatId: null, turn: 'user', itemId: null, label: '', at: 1 },
    1,
    newId
  ).file
  const id = f.items[0]!.id
  f = assignTodo(f, id, 'builder', '/w', 2).file
  f = startTask(f, id, { agent: 'builder', chatId: 'c1', at: 2 }, 2).file
  const reviewed = reviewTodo(f, id, 'c1', 'done', 3).file
  const asked = askTodo(f, id, 'c1', 'builder', [{ text: 'A?' }, { text: 'B?' }], 4, newId).file
  return [f.items[0]!, reviewed.items[0]!, asked.items[0]!]
}
const agent = (name: string, over: Partial<AgentSummary> = {}): AgentSummary => ({
  filePath: `/a/${name}.md`,
  name,
  description: '',
  color: null,
  icon: null,
  error: null,
  builtIn: false,
  ...over
})

describe('cardState', () => {
  it('reads the task chat from the chat list and the approval counts', () => {
    const [given] = card()
    const chats = [{ id: 'c1', inFlight: false }]
    expect(cardState(given!, chats, {})).toBeNull()
    expect(cardState(given!, [{ id: 'c1', inFlight: true }], {})).toBe('working')
    expect(cardState(given!, chats, { c1: 2 })).toBe('approval')
    expect(cardState(given!, [], {})).toBe('gone')
    expect(cardState({ ...given!, task: undefined }, chats, {})).toBeNull()
    // Given to the user since: its old chat is no longer its work.
    expect(cardState({ ...given!, assignee: 'user' }, [], {})).toBeNull()
    expect([
      STATE_LABEL.approval,
      statusTone('approval'),
      statusTone('blocked'),
      statusTone('review'),
      statusTone('progress'),
      statusTone('working'),
      statusTone('new')
    ]).toEqual(['Needs approval', 'you', 'you', 'you', 'busy', 'busy', 'quiet'])
  })
})

describe('assignee picker', () => {
  it('maps the assignee to the picker and back', () => {
    expect([assignValue(undefined), assignValue('user'), assignValue('builder')]).toEqual([ASSIGN_NOBODY, ASSIGN_ME, 'builder'])
    expect([assigneeOf(ASSIGN_NOBODY), assigneeOf(ASSIGN_ME), assigneeOf('builder')]).toEqual([null, 'user', 'builder'])
  })
})

describe('give', () => {
  it('lists loadable agents but Zumi Bot, by name', () => {
    expect(
      givableAgents([agent('zed'), agent('zumi-bot', { builtIn: true }), agent('bad', { error: 'x' }), agent('amy')]).map((a) => a.name)
    ).toEqual(['amy', 'zed'])
  })
  it('leaves out an agent whose engine has no bridges: its task chat would have no to-do tools', () => {
    expect(givableAgents([agent('zed'), agent('gem', { provider: 'acp' }), agent('cx', { provider: 'codex' })]).map((a) => a.name)).toEqual(
      ['cx', 'zed']
    )
  })
  it("starts from the creator chat's folder, a worktree's checkout, or nothing for a card made on the board", () => {
    expect(giveFolder({ cwd: '/repo/sub' })).toBe('/repo/sub')
    expect(giveFolder({ cwd: '/wt/x', worktree: { root: '/wt/x', branch: 'zumibot/x', source: '/repo' } as never })).toBe('/repo')
    expect(giveFolder(null)).toBeNull()
  })
})

describe('answers and hints', () => {
  it('sends the open questions with a non-blank draft, trimmed, in order', () => {
    const asked = card()[2]!
    const [a, b] = asked.questions!
    expect(answersToSend(asked.questions, { [b!.id]: ' yes ', [a!.id]: '  ' })).toEqual([{ id: b!.id, text: 'yes' }])
    expect(answersToSend(undefined, {})).toEqual([])
  })
  it('hints at notes, files and open questions', () => {
    expect(cardHints(card()[2]!)).toEqual({ notes: true, files: 0, questions: 2, comments: 0 })
  })
})

describe('quickFolder', () => {
  const chat = { cwd: '/repo', worktree: null }
  it('keeps the card folder while its agent stays, else uses the creator chat, else asks the server', () => {
    expect(quickFolder({ assignee: 'dev', folder: '/own' }, 'dev', chat)).toBe('/own')
    expect(quickFolder({ assignee: 'dev', folder: '/own' }, 'qa', chat)).toBe('/repo')
    expect(quickFolder({ assignee: undefined, folder: undefined }, 'qa', null)).toBeNull()
  })
})

describe('cardHints comments', () => {
  it('counts live comments only', () => {
    const item = {
      description: undefined,
      files: undefined,
      questions: undefined,
      comments: [
        { id: 'a', text: 'x', by: 'user', at: 1 },
        { id: 'b', text: '', by: 'user', at: 2, deletedAt: 3 }
      ]
    } as never
    expect(cardHints(item).comments).toBe(1)
  })
})
