import type { ChatMeta } from '@zumibot/shared/types'
import { UNTITLED_ROOM } from '@zumibot/shared/roomClone'
import type { ChatStore } from '../store/chatStore'
import type { ChatService } from './chatService'

export interface CloneDeps {
  store: Pick<ChatStore, 'get' | 'createGroup' | 'update' | 'remove'>
  allowed: Pick<ChatService, 'copyAllowed'>
  now(): number
}

/** A new room with the same members, role and folder, and no history. The handoff is the only thing it starts from.
 * A worktree room's copy shares its worktree only with keepWorktree (Clone room). Without it (a workflow Room step: unattended runs must not share a folder that cleanup can remove) it is a plain room in the folder the user picked. */
export async function cloneRoom(
  d: CloneDeps,
  chatId: string,
  title: string,
  handoff: string | null,
  o?: { keepWorktree?: boolean }
): Promise<ChatMeta> {
  const src = await d.store.get(chatId)
  if (!src) throw new Error(`Chat not found: ${chatId}`)
  if (!src.group) throw new Error('Not a group chat')

  const keep = o?.keepWorktree === true && src.worktree !== undefined
  const fresh = await d.store.createGroup(
    src.group.members,
    keep ? src.cwd : (src.worktree?.folder ?? src.cwd),
    src.group.role,
    keep ? { worktree: src.worktree } : undefined
  )
  // Never the source's own handoff: a clone without a summary starts clean.
  const group =
    handoff === null
      ? fresh.group!
      : { ...fresh.group!, handoff: { text: handoff, from: { chatId: src.id, title: src.title.trim() || UNTITLED_ROOM }, at: d.now() } }
  let chat: ChatMeta
  try {
    chat = await d.store.update(fresh.id, { title, group })
  } catch (err) {
    await d.store.remove(fresh.id).catch(() => undefined)
    throw err
  }
  // Last, so a failure above leaves no allowance behind for a room that does not exist.
  for (const m of src.group.members) d.allowed.copyAllowed(`${src.id}:${m}`, `${chat.id}:${m}`)
  return chat
}
