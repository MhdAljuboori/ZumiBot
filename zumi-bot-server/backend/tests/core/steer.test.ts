import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import type { Attachment, ChatItem, QueuedTask } from '@zumibot/shared/types'
import { messagePrompt, needsAttachmentDir, steeredItem } from '../../src/core/chat/steer'

const tmp = mkdtempSync(join(tmpdir(), 'zumibot-steer-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))
const file: Attachment = { id: 'f1', name: 'notes.txt', mime: 'text/plain', size: 3, kind: 'file' }
const image: Attachment = { id: 'i1', name: 'shot.png', mime: 'image/png', size: 4, kind: 'image' }
const pathOf = (a: Attachment) => join(tmp, a.name)

test('needsAttachmentDir is true only for a file that is not an image', () => {
  expect(needsAttachmentDir(undefined)).toBe(false)
  expect(needsAttachmentDir([])).toBe(false)
  expect(needsAttachmentDir([image])).toBe(false)
  expect(needsAttachmentDir([image, file])).toBe(true)
})

test('steeredItem is the user bubble of a steer, marked steered', () => {
  const task: QueuedTask = { id: 's-1', text: 'more', attachments: [image], replyTo: 'a1', ts: 5 }
  expect(steeredItem(task, 9)).toEqual({ type: 'user', id: 's-1', text: 'more', ts: 9, attachments: [image], replyTo: 'a1', steered: true })
  expect(steeredItem({ id: 's-2', text: 'x', ts: 1 }, 2)).toEqual({ type: 'user', id: 's-2', text: 'x', ts: 2, steered: true })
})

test('messagePrompt reads a message as a turn prompt does: quote, file note, image blocks', async () => {
  writeFileSync(pathOf(image), 'png!')
  const items: ChatItem[] = [{ type: 'assistant', id: 'a1', text: 'the earlier answer', ts: 1 }]
  const { noted, blocks } = await messagePrompt(
    { type: 'user', id: 'u', text: 'use this', ts: 2, replyTo: 'a1', attachments: [file, image] },
    items,
    'agent',
    true,
    pathOf
  )
  expect(noted).toContain('<reply_to>\nthe earlier answer\n</reply_to>\n\nuse this')
  expect(noted).toContain(`- notes.txt: ${pathOf(file)} [file ID: f1]`)
  expect(blocks).toEqual([
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('png!').toString('base64') } }
  ])
})
