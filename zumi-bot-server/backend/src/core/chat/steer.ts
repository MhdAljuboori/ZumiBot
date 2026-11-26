import type { Attachment, ChatItem, QueuedTask } from '@zumibot/shared/types'
import { imageBlocks, refsOf, withNote, type PathOf } from '../attachments/content'
import { readAs } from './commandText'
import type { ImageBlock } from './controlProtocol'
import { repliedItem, withReply } from './reply'

// Mid-turn messages: a user message written into a running reply (see docs/architecture/mid-turn-messages.md).

type UserItem = Extract<ChatItem, { type: 'user' }>

/**
 * A user message as the agent reads it: the quote of the reply it answers, the text, and the note naming its files, plus the
 * image blocks that go beside it. One builder for a turn's own prompt and a steer, so both read alike.
 */
export async function messagePrompt(
  user: UserItem,
  items: readonly ChatItem[],
  agentName: string,
  bridges: boolean,
  pathOf: PathOf
): Promise<{ noted: string; blocks: ImageBlock[] }> {
  const refs = refsOf(user.attachments ?? [], pathOf)
  const noted = withNote(
    withReply(readAs(user, agentName, bridges), repliedItem(items, user.replyTo), user.command?.engine === 'claude'),
    refs
  )
  return { noted, blocks: await imageBlocks(refs) }
}

/** A file the agent opens by its path: the running CLI reads it only when it was started with the attachments folder. */
export const needsAttachmentDir = (attachments: readonly Attachment[] | undefined): boolean =>
  (attachments ?? []).some((a) => a.kind !== 'image')

/** The bubble a steer becomes once the CLI took it in. */
export const steeredItem = (task: QueuedTask, ts: number): UserItem => ({
  type: 'user',
  id: task.id,
  text: task.text,
  ts,
  ...(task.attachments ? { attachments: task.attachments } : {}),
  ...(task.replyTo !== undefined ? { replyTo: task.replyTo } : {}),
  steered: true
})
