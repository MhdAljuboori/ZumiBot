import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { listChatFiles } from '@zumibot/shared/chatFiles'
import { RESTORE_REFUSALS, restorePlan, type RestoreRefusal } from '@zumibot/shared/fileRestore'
import type { ChatItem, ChatMeta } from '@zumibot/shared/types'
import { writeFileAtomic } from '../fsutil'
import type { SnapshotStore } from './snapshotStore'

export interface RestoreDeps {
  chat(chatId: string): Promise<ChatMeta | null>
  items(chatId: string): Promise<ChatItem[]>
  snapshots: Pick<SnapshotStore, 'read'>
  home: string
  claudeDir?: string
  /** A regular file's bytes, at most one past the snapshot cap; rejects for anything else (app's fstat-checked read). */
  readFile(path: string): Promise<Buffer>
  /** Moves a file the change created to the Trash, so even this undo can be undone. */
  trash(path: string): Promise<void>
  /** Defaults to an atomic write that keeps the file's mode and follows a symlink to its target. */
  write?(path: string, text: string): Promise<void>
  log(msg: string, err?: unknown): void
}

export type RestoreResult = { done: 'written' | 'trashed' | 'unchanged' }

const refuse = (why: RestoreRefusal): never => {
  throw new Error(RESTORE_REFUSALS[why])
}

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

/**
 * Puts a file back as it was before steps `fromId`..`toId`. The path and both copies come from the chat's own stored
 * changes, never from the caller, so the client can name only a file this chat's agents changed.
 */
export async function restoreFile(d: RestoreDeps, chatId: string, path: string, fromId: string, toId: string): Promise<RestoreResult> {
  const meta = await d.chat(chatId)
  if (!meta) throw new Error(`Chat not found: ${chatId}`)
  // An agent writing the same file meanwhile would race the check below.
  if (meta.inFlight) refuse('running')
  const list = listChatFiles(await d.items(chatId), meta.cwd, d.home, d.claudeDir)
  const file = list.changed.find((f) => f.path === path)
  if (!file) refuse('gone')
  const plan = restorePlan(file!, fromId, toId)
  if ('refused' in plan) return refuse(plan.refused)

  // Content, not mtime: the file must be exactly what the change left, so nothing written since is lost.
  if ('id' in plan.expect) {
    const buf = await d.readFile(path).catch(() => null)
    if (buf === null || sha256(buf) !== plan.expect.id) refuse('changed')
  } else {
    const there = await fs.lstat(path).then(
      () => true,
      (err: NodeJS.ErrnoException) => err.code !== 'ENOENT'
    )
    if (there) refuse('changed')
  }

  if ('remove' in plan.put) {
    if (!('id' in plan.expect)) return { done: 'unchanged' } // created then deleted: already as it was
    try {
      await d.trash(path)
    } catch (err) {
      d.log('file restore failed', err)
      refuse('failed')
    }
    return { done: 'trashed' }
  }
  if ('id' in plan.expect && plan.expect.id === plan.put.id) return { done: 'unchanged' }
  const text = await d.snapshots.read(chatId, plan.put.id)
  if (text === null) refuse('noBefore')
  try {
    await (d.write ?? ((p, t) => writeFileAtomic(p, t)))(path, text!)
  } catch (err) {
    d.log('file restore failed', err)
    refuse('failed')
  }
  return { done: 'written' }
}
