// The service worker's "open this chat" message can arrive before React has mounted, so main.tsx listens at
// module load and this holds the latest one until the app subscribes.

export function openChatMessage(data: unknown): { chatId: string | null } | null {
  if (!data || typeof data !== 'object') return null
  const { type, chatId } = data as { type?: unknown; chatId?: unknown }
  if (type !== 'open-chat' || (chatId !== null && typeof chatId !== 'string')) return null
  return { chatId }
}

export interface OpenChatBus {
  emit(chatId: string): void
  on(cb: (chatId: string) => void): () => void
}

export function createOpenChatBus(): OpenChatBus {
  const subs = new Set<(chatId: string) => void>()
  let held: string | null = null
  return {
    emit(chatId) {
      if (subs.size === 0) {
        held = chatId
        return
      }
      for (const cb of [...subs]) cb(chatId)
    },
    on(cb) {
      subs.add(cb)
      if (held !== null) {
        const id = held
        held = null
        cb(id)
      }
      return () => {
        subs.delete(cb)
      }
    }
  }
}

export const openChatBus = createOpenChatBus()
