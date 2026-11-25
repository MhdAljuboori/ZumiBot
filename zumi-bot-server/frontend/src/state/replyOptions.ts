import type { SuggestedReplies } from '@zumibot/shared/types'

/** What the chat offers as the user's next message: buttons, the composer's placeholder, or nothing. */
export type ReplyOptionsView = { buttons: string[]; question?: string; summary?: string } | { placeholder: string } | null

export function replyOptionsOf(o: {
  on: boolean
  suggested: SuggestedReplies | undefined
  lastItemId: string | null
  running: boolean
  draftEmpty: boolean // no text, no file and no reply quote
}): ReplyOptionsView {
  // Stored options outlive their reply (a send from another tab, an edit, a version switch): shown only while it is last.
  if (!o.on || o.running || !o.draftEmpty || !o.suggested || o.suggested.after !== o.lastItemId) return null
  const { options, question, summary } = o.suggested
  if (options.length === 1) return { placeholder: options[0] }
  if (options.length !== 2 && options.length !== 3) return null
  return { buttons: options, ...(question ? { question } : {}), ...(summary ? { summary } : {}) }
}

interface BoxNode {
  type?: string
  content?: BoxNode[]
}

/** Whether the composer holds nothing the user started: an empty code block, list or quote is theirs, not blank. */
export function isBlankBox(doc: BoxNode): boolean {
  const blocks = doc.content ?? []
  if (blocks.length === 0) return true
  return blocks.length === 1 && blocks[0].type === 'paragraph' && (blocks[0].content?.length ?? 0) === 0
}
