import { describe, expect, it } from 'vitest'
import {
  INBOX_KEPT,
  STRIP_AFTER_MS,
  TOMBSTONE_KEEP_MS,
  isNewMessage,
  pruneMessages,
  type WorkflowMessage,
  type WorkflowMessagesFile
} from '../src/inbox'

const msg = (id: string, at: number, extra: Partial<WorkflowMessage> = {}): WorkflowMessage => ({
  id,
  workflowId: 'w',
  workflowName: 'W',
  runId: 'r',
  stepName: 'S',
  title: `t${id}`,
  body: `b${id}`,
  at,
  updatedAt: at,
  ...extra
})
const file = (messages: WorkflowMessage[], seenAt = 0): WorkflowMessagesFile => ({ v: 1, seenAt, messages })
const NOW = 10_000_000_000

describe('pruneMessages', () => {
  it('keeps newest 500 live messages and all young tombstones', () => {
    const live = Array.from({ length: INBOX_KEPT + 20 }, (_, i) => msg(`m${i}`, 1000 + i))
    const tombs = Array.from({ length: 30 }, (_, i) => msg(`d${i}`, i, { deletedAt: NOW - 1000, updatedAt: NOW - 1000 }))
    const out = pruneMessages(file([...live, ...tombs]), NOW).messages
    const liveOut = out.filter((m) => m.deletedAt === undefined)
    expect(liveOut).toHaveLength(INBOX_KEPT)
    expect(liveOut.some((m) => m.id === 'm0')).toBe(false)
    expect(liveOut.some((m) => m.id === `m${INBOX_KEPT + 19}`)).toBe(true)
    expect(out.filter((m) => m.deletedAt !== undefined)).toHaveLength(30)
  })

  it('strips text of tombstones older than 60 s', () => {
    const old = msg('a', 1, { deletedAt: NOW - STRIP_AFTER_MS - 1 })
    const young = msg('b', 2, { deletedAt: NOW - STRIP_AFTER_MS })
    const [a, b] = pruneMessages(file([old, young]), NOW).messages
    expect(a.title).toBe('')
    expect('body' in a).toBe(false)
    expect(b.title).toBe('tb')
    expect(b.body).toBe('bb')
  })

  it('drops tombstones older than 365 days', () => {
    const gone = msg('a', 1, { deletedAt: NOW - TOMBSTONE_KEEP_MS - 1 })
    const kept = msg('b', 2, { deletedAt: NOW - TOMBSTONE_KEEP_MS + 1 })
    expect(pruneMessages(file([gone, kept]), NOW).messages.map((m) => m.id)).toEqual(['b'])
  })
})

describe('isNewMessage', () => {
  it('is false when archived or at <= seenAt', () => {
    expect(isNewMessage(msg('a', 10), 5)).toBe(true)
    expect(isNewMessage(msg('a', 10), 10)).toBe(false)
    expect(isNewMessage(msg('a', 10, { archivedAt: 11 }), 5)).toBe(false)
    expect(isNewMessage(msg('a', 10, { deletedAt: 11 }), 5)).toBe(false)
  })
})
