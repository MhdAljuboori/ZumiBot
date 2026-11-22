import type { ChatMeta } from '@zumibot/shared/types'

/** How many chats a folder lists before Show more. */
export const FOLDER_SHOWN = 5
/** How many more each Show more lists. */
export const FOLDER_STEP = 10

export interface FolderRows {
  rows: ChatMeta[]
  /** Chats left out, so the folder offers Show more. */
  hidden: number
  /** Show more listed them all, so the folder offers Show less. */
  less: boolean
}

/**
 * What a folder lists: its newest `shown` chats (all of them while a search runs), plus any older one that must stay
 * in sight, such as the open chat or one waiting for an approval, in their own order.
 */
export function folderRows(chats: readonly ChatMeta[], shown: number | 'all', keep: (chat: ChatMeta) => boolean): FolderRows {
  if (shown === 'all') return { rows: [...chats], hidden: 0, less: false }
  const rows = chats.filter((c, i) => i < shown || keep(c))
  const hidden = chats.length - rows.length
  return { rows, hidden, less: hidden === 0 && shown > FOLDER_SHOWN && chats.length > FOLDER_SHOWN }
}

/** A folder's key for how many chats it shows: the same folder under two agents is two lists. */
export const folderKey = (agentName: string, cwd: string): string => `${agentName}\n${cwd}`
