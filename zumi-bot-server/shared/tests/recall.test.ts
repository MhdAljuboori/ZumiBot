import { describe, expect, it } from 'vitest'
import type { ChatMeta } from '@zumibot/shared/types'
import { inRecallScope, parseRecall, recallFolderOf } from '@zumibot/shared/recall'
import { parseAgent, serializeAgent } from '@zumibot/shared/frontmatter'

const chat = (id: string, over: Partial<ChatMeta> = {}): ChatMeta => ({
  id,
  agentName: 'ann',
  sessionId: null,
  cwd: '/work/app',
  title: id,
  createdAt: 0,
  updatedAt: 0,
  inFlight: false,
  ...over
})
const room = (id: string, members: string[], over: Partial<ChatMeta> = {}): ChatMeta =>
  chat(id, {
    agentName: '',
    group: { members, sessions: {}, seen: {}, role: '', active: [], queue: [] } as unknown as ChatMeta['group'],
    ...over
  })

describe('parseRecall', () => {
  it('takes exactly agent or folder; anything else is off', () => {
    expect(parseRecall('agent')).toBe('agent')
    expect(parseRecall('folder')).toBe('folder')
    for (const v of ['Agent', 'folder ', 'on', true, 1, null, undefined, {}]) expect(parseRecall(v)).toBeNull()
  })
})

describe('recallFolderOf', () => {
  it('is the picked folder for a worktree chat, else its cwd', () => {
    expect(recallFolderOf(chat('a'))).toBe('/work/app')
    const wt = { root: '/wt/x', branch: 'zumibot/x', source: '/work/app', folder: '/work/app' } as ChatMeta['worktree']
    expect(recallFolderOf(chat('b', { cwd: '/wt/x/sub', worktree: wt }))).toBe('/work/app')
  })
})

describe('inRecallScope', () => {
  const from = chat('here')
  it('never includes the chat the call comes from', () => {
    expect(inRecallScope('agent', 'ann', from, from)).toBe(false)
    expect(inRecallScope('folder', 'ann', from, from)).toBe(false)
  })
  it('agent scope: its single chats and rooms it is a member of, in any folder', () => {
    expect(inRecallScope('agent', 'ann', from, chat('mine', { cwd: '/elsewhere' }))).toBe(true)
    expect(inRecallScope('agent', 'ann', from, chat('bobs', { agentName: 'bob' }))).toBe(false)
    expect(inRecallScope('agent', 'ann', from, room('r1', ['bob', 'ann']))).toBe(true)
    expect(inRecallScope('agent', 'ann', from, room('r2', ['bob', 'cy']))).toBe(false)
  })
  it('folder scope: every chat of the same folder, whatever agent ran it', () => {
    expect(inRecallScope('folder', 'ann', from, chat('bobs', { agentName: 'bob' }))).toBe(true)
    expect(inRecallScope('folder', 'ann', from, room('r', ['bob', 'cy']))).toBe(true)
    expect(inRecallScope('folder', 'ann', from, chat('other', { cwd: '/work/app/sub' }))).toBe(false)
    expect(inRecallScope('folder', 'ann', from, chat('mine', { cwd: '/elsewhere' }))).toBe(false)
  })
})

describe('recall frontmatter key', () => {
  const raw = '---\nname: a\ndescription: d\n---\nBody\n'
  it('parses recall and drops an unknown value', () => {
    const f = (line: string) => (parseAgent(`---\nname: a\ndescription: d\n${line}---\n`) as any).fields.recall
    expect(f('recall: folder\n')).toBe('folder')
    expect(f('recall: agent\n')).toBe('agent')
    expect(f('recall: yes\n')).toBeNull()
    expect(f('')).toBeNull()
  })
  it('writes the key, and Off removes it', () => {
    const p = parseAgent(raw) as any
    const on = serializeAgent(raw, { ...p.fields, recall: 'folder' }, p.body)
    expect(on).toContain('recall: folder\n')
    const back = parseAgent(on) as any
    expect(serializeAgent(on, { ...back.fields, recall: null }, back.body)).toBe(raw)
  })
})
