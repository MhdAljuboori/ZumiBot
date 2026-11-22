import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { addTodos, checkTodos, emptyTodos, type TodoFile } from '@zumibot/shared/todos'
import { AttachmentStore } from '../../src/core/attachments/attachmentStore'
import { ChatStore } from '../../src/core/store/chatStore'
import { mergeLegacyTodos, migrateToBoard } from '../../src/core/todos/boardMigration'

// A per-chat list as it was before the board: sources without a chat id.
const legacyList = (texts: string[], by: string, at: number, prefix: string): TodoFile => {
  const f = addTodos(
    emptyTodos(),
    texts.map((text) => ({ text })),
    by,
    { turn: 't', itemId: 'r1', label: 'Reply', at } as never,
    at,
    (() => {
      let n = 0
      return () => `${prefix}${++n}`
    })()
  ).file
  return { ...f, items: f.items.map(({ from: { chatId: _c, ...from }, ...i }) => ({ ...i, from })) as never, seen: { [by]: f.rev } }
}

describe('mergeLegacyTodos', () => {
  it("folds each chat's items in with that chat as their source, one new rev, and its sessions as having seen them", () => {
    const board = addTodos(
      emptyTodos(),
      [{ text: 'mine' }],
      'user',
      { chatId: null, turn: 'user', itemId: null, label: 'Added by you', at: 1 },
      1,
      () => 'own1'
    ).file
    const merged = mergeLegacyTodos(board, [
      { chatId: 'chat-a', file: legacyList(['a1', 'a2'], 'digest', 5, 'a') },
      { chatId: 'chat-b', file: legacyList(['b1'], 'writer', 6, 'b') }
    ])
    expect(merged.items.map((i) => [i.id, i.from.chatId, i.rev])).toEqual([
      ['own1', null, 1],
      ['a1', 'chat-a', 2],
      ['a2', 'chat-a', 2],
      ['b1', 'chat-b', 2]
    ])
    expect(merged.rev).toBe(2)
    expect(merged.seen).toEqual({ 'chat-a/digest': 2, 'chat-b/writer': 2 })
    expect(mergeLegacyTodos(board, [])).toBe(board)
  })

  it('keeps the later copy of an id the board already has, so running again after a sync is safe', () => {
    const list = legacyList(['a1'], 'digest', 5, 'a')
    const once = mergeLegacyTodos(emptyTodos(), [{ chatId: 'chat-a', file: list }])
    const ticked = checkTodos(once, ['a1'], true, 'user', 50).file
    const again = mergeLegacyTodos(ticked, [{ chatId: 'chat-a', file: list }])
    expect(again.items).toHaveLength(1)
    expect(again.items[0]!.done).toEqual({ at: 50, by: 'user' })
  })
})

describe('migrateToBoard', () => {
  let dir: string
  let store: ChatStore
  let files: AttachmentStore
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-migrate-'))
    store = new ChatStore(join(dir, 'data'))
    files = new AttachmentStore(join(dir, 'attachments'), () => 'f1')
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  const deps = (logs: string[] = []) => ({
    store,
    copyFiles: (from: string, to: string, list: never[]) => files.copyFiles(from, to, list),
    removeFolder: (k: string) => files.removeChat(k),
    log: (l: string) => logs.push(l)
  })

  it('moves every chat list onto the board with its card files, removes the old files, and does nothing the second time', async () => {
    const chat = await store.create('digest', '/a')
    const staged = await files.stageBytes('shot.png', new Uint8Array([1, 2, 3]))
    if (!staged.ok) throw new Error(staged.error)
    const [att] = await files.commit(chat.id, [staged.attachment.id])
    const list = legacyList(['Reply to Morjan'], 'digest', 5, 'a')
    list.items[0] = { ...list.items[0]!, files: [att!] }
    await fs.mkdir(join(dir, 'data', 'chats'), { recursive: true })
    await fs.writeFile(join(dir, 'data', 'chats', `${chat.id}.todos.json`), JSON.stringify(list))
    await fs.writeFile(join(dir, 'data', 'chats', 'broken.todos.json'), '{')
    const logs: string[] = []
    expect(await migrateToBoard(deps(logs))).toBe(1)
    const board = await store.loadBoard()
    expect(board.items.map((i) => [i.text, i.from.chatId, i.addedBy])).toEqual([['Reply to Morjan', chat.id, 'digest']])
    expect(await files.chatFile('todos', att!.id)).not.toBeNull()
    await expect(fs.access(join(dir, 'data', 'chats', `${chat.id}.todos.json`))).rejects.toThrow()
    // A list that does not parse stays, named by its chat id only.
    await expect(fs.access(join(dir, 'data', 'chats', 'broken.todos.json'))).resolves.toBeUndefined()
    expect(logs).toEqual(['todo board: left an unreadable list in place: broken'])
    expect(await migrateToBoard(deps())).toBe(0)
    expect((await store.loadBoard()).rev).toBe(board.rev)
  })
})
