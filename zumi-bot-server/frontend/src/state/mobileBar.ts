import type { ChatMeta } from '@zumibot/shared/types'
import { chatTitle } from './sidebarTree'

/** What the small-screen bar over the main area names: the open chat, else the screen showing. */
export function barTitle(
  view: 'empty' | 'start' | 'chat' | 'editor',
  chat: Pick<ChatMeta, 'title'> | undefined,
  groupMode: boolean,
  agents: readonly { name: string }[]
): string {
  if (view === 'chat' && chat) return chatTitle(chat, agents)
  if (view === 'editor') return 'Agent Studio'
  return view === 'empty' && groupMode ? 'New group chat' : 'New chat'
}

/** Whether a chat other than the open one waits on an approval: the drawer's toggle shows a dot then. */
export function pendingElsewhere(pendingByChat: Record<string, number>, openChatId: string | null): boolean {
  return Object.entries(pendingByChat).some(([id, n]) => id !== openChatId && n > 0)
}
