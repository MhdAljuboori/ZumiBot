const KEY = 'zumibot:drafts'

/** Keeps unsent text across the sign-out redirect. Storage can be missing or throw, so every access is guarded. */
export function saveDrafts(storage: Storage | null, drafts: Record<string, string>): void {
  try {
    const kept = Object.fromEntries(Object.entries(drafts).filter(([, text]) => text.trim() !== ''))
    storage?.setItem(KEY, JSON.stringify(kept))
  } catch {
    // best effort
  }
}

export function clearDrafts(storage: Storage | null): void {
  try {
    storage?.removeItem(KEY)
  } catch {
    // best effort
  }
}

/** Reads the saved drafts once: the key is removed so a later reload does not bring back text that was sent meanwhile. */
export function loadDrafts(storage: Storage | null): Record<string, string> {
  try {
    const raw = storage?.getItem(KEY)
    clearDrafts(storage)
    if (!raw) return {}
    const v: unknown = JSON.parse(raw)
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return {}
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'))
  } catch {
    return {}
  }
}

export const sessionDrafts = (): Storage | null => {
  try {
    return sessionStorage
  } catch {
    return null
  }
}
