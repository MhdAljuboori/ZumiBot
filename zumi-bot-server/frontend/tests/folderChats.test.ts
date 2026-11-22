import { describe, expect, it } from 'vitest'
import type { ChatMeta } from '@zumibot/shared/types'
import { FOLDER_SHOWN, FOLDER_STEP, folderKey, folderRows } from '../src/state/folderChats'

const chat = (n: number): ChatMeta => ({
  id: `c${n}`,
  agentName: 'writer',
  sessionId: null,
  cwd: '/w/site',
  title: `Chat ${n}`,
  createdAt: 0,
  updatedAt: 1000 - n,
  inFlight: false
})
const chats = (count: number): ChatMeta[] => Array.from({ length: count }, (_, i) => chat(i))
const none = (): boolean => false
const ids = (rows: ChatMeta[]): string[] => rows.map((c) => c.id)

describe('folderRows', () => {
  it('lists a short folder whole, with no button', () => {
    expect(folderRows(chats(FOLDER_SHOWN), FOLDER_SHOWN, none)).toEqual({ rows: chats(FOLDER_SHOWN), hidden: 0, less: false })
  })

  it('lists the newest few of a long folder and counts the rest', () => {
    const r = folderRows(chats(12), FOLDER_SHOWN, none)
    expect(ids(r.rows)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4'])
    expect(r.hidden).toBe(7)
    expect(r.less).toBe(false)
  })

  it('lists one more step after Show more, and offers Show less once nothing is left out', () => {
    const more = folderRows(chats(30), FOLDER_SHOWN + FOLDER_STEP, none)
    expect(more.rows).toHaveLength(FOLDER_SHOWN + FOLDER_STEP)
    expect(more).toMatchObject({ hidden: 30 - FOLDER_SHOWN - FOLDER_STEP, less: false })
    expect(folderRows(chats(12), FOLDER_SHOWN + FOLDER_STEP, none)).toMatchObject({ hidden: 0, less: true })
  })

  it('keeps an older chat that must stay in sight, in its place', () => {
    const r = folderRows(chats(12), FOLDER_SHOWN, (c) => c.id === 'c9')
    expect(ids(r.rows)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c9'])
    expect(r.hidden).toBe(6)
  })

  it('offers no button when the kept chats leave nothing out', () => {
    expect(folderRows(chats(7), FOLDER_SHOWN, (c) => c.id === 'c5' || c.id === 'c6')).toMatchObject({ hidden: 0, less: false })
  })

  it('offers no Show less once deletes bring an opened folder back under the limit', () => {
    expect(folderRows(chats(FOLDER_SHOWN), FOLDER_SHOWN + FOLDER_STEP, none)).toMatchObject({ hidden: 0, less: false })
  })

  it('lists every chat while a search runs, with no button', () => {
    expect(folderRows(chats(40), 'all', none)).toEqual({ rows: chats(40), hidden: 0, less: false })
  })
})

describe('folderKey', () => {
  it('tells the same folder under two agents apart', () => {
    expect(folderKey('writer', '/w/site')).not.toBe(folderKey('reviewer', '/w/site'))
  })
})
