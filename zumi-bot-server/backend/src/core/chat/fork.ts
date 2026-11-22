import type { Attachment, ChatItem, ChatMeta, ForkResult, GroupInfo, NextStart } from '@zumibot/shared/types'
import { isOpen } from '@zumibot/shared/btw'
import type { AttachmentStore } from '../attachments/attachmentStore'
import type { SnapshotStore } from '../files/snapshotStore'
import type { ChatStore } from '../store/chatStore'
import {
  droppedTurn,
  enginesAfter,
  memberStartsAfterMessage,
  memberStartsBefore,
  startAfterMessage,
  startBefore,
  withSessionEngines
} from './sessionPoints'

export interface ForkDeps {
  store: ChatStore
  files: Pick<AttachmentStore, 'copyFiles' | 'stagePath' | 'pathOf' | 'removeChat'>
  snapshots?: Pick<SnapshotStore, 'copy' | 'removeChat'>
  now(): number
}

const NOT_FOUND = 'Message not found'

/** Copy of an item for the new chat: no version marker, never live, and no approval left waiting for nobody. */
function plain(it: ChatItem): ChatItem {
  const { versions: _v, ...rest } = it as ChatItem & { versions?: unknown }
  // A fork is a fresh context and takes no chat-scope allow rules (`ChatMeta.allowRules` is not copied): the user grants
  // again. A row allowed "always for the agent" stays so, since that rule is the agent's.
  if (rest.type === 'tool' && rest.allowedAs === 'chat') {
    const { allowedAs: _a, ...tool } = rest
    return tool as ChatItem
  }
  if (rest.type === 'vault-approval' && rest.request.status === 'pending')
    return { ...rest, request: { ...rest.request, status: 'interrupted' } }
  return rest.type === 'approval' && rest.status === 'pending' ? { ...rest, status: 'unanswered' } : (rest as ChatItem)
}

export async function forkChat(d: ForkDeps, chatId: string, itemId: string): Promise<ForkResult> {
  const src = await d.store.get(chatId)
  if (!src) throw new Error(`Chat not found: ${chatId}`)
  const items = await d.store.loadItems(chatId)
  const i = items.findIndex((it) => it.id === itemId)
  const msg = items[i]
  // Only a visible message that is done can be forked at; hidden versions are not in `items`.
  if (!msg || ('turn' in msg && msg.turn !== undefined) || (msg.type !== 'user' && msg.type !== 'assistant')) throw new Error(NOT_FOUND)

  const isUser = msg.type === 'user'
  const end = isUser ? i : i + 1
  const copied = items
    .slice(0, end)
    .filter((it) => !('turn' in it && it.turn !== undefined))
    .map(plain)
  const keep = new Set(copied.map((it) => it.id))
  const reactions = Object.fromEntries(Object.entries(src.reactions ?? {}).filter(([id]) => keep.has(id)))
  const title = `Fork of ${src.title || 'chat'}`

  const fresh = src.group
    ? await d.store.createGroup(src.group.members, src.cwd, src.group.role)
    : await d.store.create(src.agentName, src.cwd)
  try {
    const patch: Partial<Omit<ChatMeta, 'id'>> = {
      title,
      updatedAt: d.now(),
      ...(Object.keys(reactions).length > 0 ? { reactions } : {}),
      // The cut session's cache is on this model: keep it, or the first turn would write it all again.
      ...(src.model !== undefined ? { model: src.model } : {}),
      ...(src.modelByHand ? { modelByHand: true as const } : {}),
      // The effort too (a different one may write the cache again), and the mode the user picked for the work.
      ...(src.effort !== undefined ? { effort: src.effort } : {}),
      ...(src.permissionMode !== undefined ? { permissionMode: src.permissionMode } : {}),
      // The copy shares the worktree folder, as it shares cwd.
      ...(src.worktree ? { worktree: src.worktree } : {})
    }
    if (src.group) {
      // Only current members: an author removed from the room can be in the stamps but is not in the fork.
      const members = src.group.members
      const points = isUser ? memberStartsBefore(items, i, members) : memberStartsAfterMessage(items, i, members)
      const sessions: GroupInfo['sessions'] = {}
      const seen: GroupInfo['seen'] = {}
      const next: Record<string, NextStart> = {}
      for (const m of members) {
        const p = points[m]
        if (!p) continue
        sessions[m] = p.sessionId
        seen[m] = p.seen
        if (p.next) next[m] = p.next
      }
      // The handoff is the room's starting context, so a fork needs it for any member that restarts from a seed.
      // Each member's session goes with its stamp's engine, as a single chat's does.
      patch.group = withSessionEngines(
        {
          ...fresh.group!,
          sessions,
          seen,
          ...(Object.keys(next).length > 0 ? { next } : {}),
          ...(src.group.handoff ? { handoff: src.group.handoff } : {})
        },
        enginesAfter(undefined, points)
      )
    } else {
      const p = isUser ? startBefore(items, i, droppedTurn(items, items[i].id)) : startAfterMessage(items, i)
      patch.sessionId = p.sessionId
      if (p.next) patch.next = p.next
      // The thread a Codex stamp points at is no Claude session: the mark goes with it, and a Claude point has none.
      if (p.engine) patch.sessionEngine = p.engine
    }
    await d.store.saveItems(fresh.id, copied)
    const side = (await d.store.loadSide(chatId)).filter((q) => !isOpen(q) && (q.after === null || keep.has(q.after)))
    if (side.length > 0) await d.store.saveSide(fresh.id, side)
    // To-dos are not copied: they live once on the board, and the items made in this chat stay listed under it.
    const atts = copied.flatMap((it) => (it.type === 'user' ? (it.attachments ?? []) : []))
    if (atts.length > 0) await d.files.copyFiles(chatId, fresh.id, atts)
    if (d.snapshots) {
      // Only the copied items' ids: a hidden version's or a later item's copies stay with the source chat.
      const copies = new Set<string>()
      for (const it of copied) {
        if (it.type !== 'tool') continue
        for (const c of it.changes ?? []) {
          if (c.before) copies.add(c.before)
          if (c.after) copies.add(c.after)
        }
      }
      if (copies.size > 0) await d.snapshots.copy(chatId, fresh.id, copies)
    }
    const chat = await d.store.update(fresh.id, patch)

    if (!isUser) return { chat, draft: null }
    // The edited message goes back to the composer, so its files are staged anew; one that is gone is left out.
    const attachments: Attachment[] = []
    for (const a of msg.attachments ?? []) {
      const r = await d.files.stagePath(d.files.pathOf(chatId, a))
      if (r.ok) attachments.push(r.attachment)
    }
    return { chat, draft: { text: msg.text, attachments } }
  } catch (err) {
    await d.store.remove(fresh.id).catch(() => undefined)
    // copyFiles may have made the new chat's folder before the failure.
    await d.files.removeChat(fresh.id).catch(() => undefined)
    await d.snapshots?.removeChat(fresh.id).catch(() => undefined)
    throw err
  }
}
