import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { STRIP_AFTER_MS, type NewWorkflowMessage } from '@zumibot/shared/inbox'
import { MESSAGE_NOT_FOUND, TOO_LATE, WorkflowMessages } from '../../src/core/workflows/workflowMessages'

let dir: string
let clock: number
let store: WorkflowMessages
const file = () => join(dir, 'workflow-messages.json')

const nm = (id: string, at = 1000): NewWorkflowMessage => ({
  id,
  workflowId: 'w',
  workflowName: 'W',
  runId: 'r',
  stepName: 'S',
  title: `title ${id}`,
  body: `body ${id}`,
  at
})

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-wf-messages-'))
  clock = 5_000_000
  store = new WorkflowMessages(dir, () => clock)
})
afterEach(async () => fs.rm(dir, { recursive: true, force: true }))

describe('WorkflowMessages', () => {
  it('reads a missing file as empty', async () => {
    expect(await store.list()).toEqual({ messages: [], seenAt: 0 })
  })

  it('add is idempotent by id', async () => {
    expect(await store.add(nm('a'))).toBe(true)
    expect(await store.add(nm('a'))).toBe(false)
    expect((await store.list()).messages).toHaveLength(1)
    expect(await store.has('a')).toBe(true)
    expect(await store.has('zz')).toBe(false)
  })

  it('reports a new message to onAdded once, not a repeat or a deleted one', async () => {
    const seen: string[] = []
    store = new WorkflowMessages(
      dir,
      () => clock,
      (m) => seen.push(m.id)
    )
    await store.add(nm('a'))
    await store.add(nm('a'))
    await store.remove('a')
    await store.add(nm('a'))
    expect(seen).toEqual(['a'])
  })

  it('a throwing onAdded does not fail add', async () => {
    store = new WorkflowMessages(
      dir,
      () => clock,
      () => {
        throw new Error('boom')
      }
    )
    expect(await store.add(nm('a'))).toBe(true)
  })

  it('add after delete returns false', async () => {
    await store.add(nm('a'))
    await store.remove('a')
    expect(await store.add(nm('a'))).toBe(false)
    expect((await store.list()).messages).toHaveLength(0)
  })

  it('list leaves tombstones out', async () => {
    await store.add(nm('a'))
    await store.add(nm('b'))
    await store.remove('a')
    expect((await store.list()).messages.map((m) => m.id)).toEqual(['b'])
  })

  it('archive then unarchive bumps updatedAt each time', async () => {
    await store.add(nm('a'))
    const t0 = (await store.list()).messages[0].updatedAt
    clock += 10
    await store.setArchived('a', true)
    const archived = (await store.list()).messages[0]
    expect(archived.archivedAt).toBe(clock)
    expect(archived.updatedAt).toBe(t0 + 10)
    clock += 10
    await store.setArchived('a', false)
    const back = (await store.list()).messages[0]
    expect(back.archivedAt).toBeUndefined()
    expect(back.updatedAt).toBe(t0 + 20)
  })

  it('restore within window brings text back', async () => {
    await store.add(nm('a'))
    await store.remove('a')
    clock += STRIP_AFTER_MS - 1
    await store.restore('a')
    const m = (await store.list()).messages[0]
    expect(m.title).toBe('title a')
    expect(m.body).toBe('body a')
    expect(m.deletedAt).toBeUndefined()
  })

  it('restore after strip throws Too late to undo', async () => {
    await store.add(nm('a'))
    await store.remove('a')
    clock += STRIP_AFTER_MS + 1
    await expect(store.restore('a')).rejects.toThrow(TOO_LATE)
    // once a later write has stripped the text, the file holds no title
    await store.add(nm('b'))
    const raw = JSON.parse(await fs.readFile(file(), 'utf8'))
    expect(raw.messages.find((m: { id: string }) => m.id === 'a').title).toBe('')
    await expect(store.restore('a')).rejects.toThrow(TOO_LATE)
  })

  it('unknown id throws Message not found', async () => {
    await expect(store.setArchived('x', true)).rejects.toThrow(MESSAGE_NOT_FOUND)
    await expect(store.remove('x')).rejects.toThrow(MESSAGE_NOT_FOUND)
    await expect(store.restore('x')).rejects.toThrow(MESSAGE_NOT_FOUND)
  })

  it('markSeen never moves back', async () => {
    await store.markSeen(100)
    await store.markSeen(50)
    expect((await store.list()).seenAt).toBe(100)
    await store.markSeen(200)
    expect((await store.list()).seenAt).toBe(200)
  })

  it('file is written 0600', async () => {
    await store.add(nm('a'))
    if (process.platform !== 'win32') expect((await fs.stat(file())).mode & 0o777).toBe(0o600)
  })

  it('reads an unreadable file as empty', async () => {
    await fs.writeFile(file(), '{not json')
    expect(await store.list()).toEqual({ messages: [], seenAt: 0 })
  })
})
