import { describe, expect, it } from 'vitest'
import type { Element } from 'hast'
import type { ProcessInfo } from '@zumibot/shared/processes'
import type { ChatItem, QueuedTask } from '@zumibot/shared/types'
import { isRunItem, latestRun, needsRunConfirm, runnableOfPre, visibleTasks, withoutRunItems } from '../src/state/runBlocks'

// A hast <pre> the way react-markdown hands it over, like Diagram's mermaidSource reads it.
const pre = (className: string[] | undefined, text: string): Element => ({
  type: 'element',
  tagName: 'pre',
  properties: {},
  children: [{ type: 'element', tagName: 'code', properties: className ? { className } : {}, children: [{ type: 'text', value: text }] }]
})

describe('runnableOfPre', () => {
  it('is the one-line shell command of a code block', () => {
    expect(runnableOfPre(pre(['language-bash'], 'ls\n'))).toBe('ls')
    expect(runnableOfPre(pre(['language-Bash'], 'ls'))).toBe('ls') // the language keeps its case
  })
  it('is null for another language, many lines, no language or no code child', () => {
    expect(runnableOfPre(pre(['language-js'], 'ls\n'))).toBeNull()
    expect(runnableOfPre(pre(['language-bash'], 'ls\npwd\n'))).toBeNull()
    expect(runnableOfPre(pre(undefined, 'ls\n'))).toBeNull()
    expect(runnableOfPre({ type: 'element', tagName: 'pre', properties: {}, children: [] })).toBeNull()
    expect(runnableOfPre({ type: 'element', tagName: 'pre', properties: {}, children: [{ type: 'text', value: 'ls' }] })).toBeNull()
    expect(runnableOfPre(undefined)).toBeNull()
  })
})

const proc = (id: string, startedAt: number, run: { messageId: string } | null, command = 'ls'): ProcessInfo =>
  ({ id, startedAt, run, command }) as ProcessInfo

describe('latestRun', () => {
  it('picks the newest run of this message and command, ignoring agent processes', () => {
    const list = [
      proc('a', 1, { messageId: 'm' }),
      proc('b', 5, { messageId: 'm' }),
      proc('c', 9, null), // an agent's own process
      proc('d', 8, { messageId: 'other' }),
      proc('e', 7, { messageId: 'm' }, 'pwd')
    ]
    expect(latestRun(list, 'm', 'ls')?.id).toBe('b')
  })
  it('is null without a list or a match', () => {
    expect(latestRun(null, 'm', 'ls')).toBeNull()
    expect(latestRun([proc('a', 1, { messageId: 'x' })], 'm', 'ls')).toBeNull()
  })
})

describe('needsRunConfirm', () => {
  it('asks only when the command holds characters the text hides', () => {
    expect(needsRunConfirm('ls')).toBe(false)
    expect(needsRunConfirm('ls‮')).toBe(true)
    expect(needsRunConfirm('rm​ -rf')).toBe(true)
  })
})

const user = (id: string, run?: true): ChatItem => ({ type: 'user', id, text: id, ts: 1, ...(run ? { run: { processId: 'p' } } : {}) })
const agent = (id: string): ChatItem => ({ type: 'assistant', id, text: id, ts: 1 })

describe('run items', () => {
  it('isRunItem is a user item with a run mark', () => {
    expect(isRunItem(user('u', true))).toBe(true)
    expect(isRunItem(user('u'))).toBe(false)
    expect(isRunItem(agent('a'))).toBe(false)
  })
  it('withoutRunItems drops only run user items', () => {
    const items = [user('u1'), user('r', true), agent('a')]
    expect(withoutRunItems(items).map((i) => i.id)).toEqual(['u1', 'a'])
  })
  it('hidden tasks leave the tray list', () => {
    const tasks: QueuedTask[] = [
      { id: 't1', text: 'x', ts: 1, run: { processId: 'p' } },
      { id: 't2', text: 'y', ts: 1 }
    ]
    expect(visibleTasks(tasks).map((t) => t.id)).toEqual(['t2'])
    expect(visibleTasks(undefined)).toEqual([])
  })
})
