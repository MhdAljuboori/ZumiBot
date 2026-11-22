import { TODO_FILES, seenKey, type TodoFile, type TodoItem } from '@zumibot/shared/todos'
import type { Attachment } from '@zumibot/shared/types'
import type { ChatStore } from '../store/chatStore'

/** The attachments folder My to-dos' card files had before the board (the cards came out with it, unreleased). */
export const LEGACY_OWN_FILES = 'my-todos'

/**
 * Folds per-chat lists into the board. Each item keeps its id and learns the chat it was made in; an id the board
 * already has keeps the later `updatedAt` (a sync can bring a list back after a migration, so this runs again safely).
 * Everything folded in is stamped with one new rev, and each folded chat's sessions are marked as having seen it, so no
 * agent is told the whole move as news; a session that never saw its list gets the board once, as a new one would.
 */
export function mergeLegacyTodos(board: TodoFile, lists: readonly { chatId: string; file: TodoFile }[]): TodoFile {
  if (lists.length === 0) return board
  const rev = board.rev + 1
  const byId = new Map(board.items.map((i) => [i.id, i]))
  const order = board.items.map((i) => i.id)
  const seen = { ...board.seen }
  for (const { chatId, file } of lists) {
    for (const raw of file.items) {
      const item: TodoItem = { ...raw, from: { ...raw.from, chatId: raw.from.chatId ?? chatId }, rev }
      const cur = byId.get(item.id)
      if (!cur) order.push(item.id)
      if (!cur || item.updatedAt > cur.updatedAt) byId.set(item.id, item)
    }
    for (const agent of Object.keys(file.seen)) seen[seenKey(chatId, agent)] = rev
  }
  return { v: 1, rev, items: order.map((id) => byId.get(id)!), seen }
}

export interface BoardMigrationDeps {
  store: Pick<ChatStore, 'legacyTodoLists' | 'updateBoard' | 'dropLegacyTodos'>
  /** Copies card files between attachment folders; a file already gone is skipped. */
  copyFiles(fromKey: string, toKey: string, files: Attachment[]): Promise<void>
  /** Removes a whole attachments folder (the old own list's, once copied). */
  removeFolder(key: string): Promise<void>
  log(line: string): void
}

/**
 * Run once at start, before anything reads the board: every chat's list moves onto it, card files first (so the board
 * never names a file that is not there), then the board, then the old files. A list that does not parse stays, logged by
 * chat id only (never its text).
 */
export async function migrateToBoard(d: BoardMigrationDeps): Promise<number> {
  const { lists, bad } = await d.store.legacyTodoLists()
  for (const chatId of bad) d.log(`todo board: left an unreadable list in place: ${chatId}`)
  for (const { chatId, file } of lists) {
    const files = file.items.flatMap((i) => i.files ?? [])
    if (files.length > 0) await d.copyFiles(chatId, TODO_FILES, files)
  }
  // My to-dos' own card files had a folder of their own; the board keeps them in its folder now.
  const board = await d.store.updateBoard((f) => mergeLegacyTodos(f, lists))
  const ownFiles = board.items.flatMap((i) => (i.from.chatId === null ? (i.files ?? []) : []))
  if (ownFiles.length > 0) await d.copyFiles(LEGACY_OWN_FILES, TODO_FILES, ownFiles)
  await d.removeFolder(LEGACY_OWN_FILES)
  if (lists.length > 0) await d.store.dropLegacyTodos(lists.map((l) => l.chatId))
  return lists.reduce((n, l) => n + l.file.items.length, 0)
}
