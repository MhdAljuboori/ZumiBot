import { cleanHotkey } from '@zumibot/shared/island'

export { cleanHotkey }

export interface VoiceHotkeyDeps {
  /** Electron's `globalShortcut.register`: false when another app holds the accelerator. */
  register(acc: string, cb: () => void): boolean
  unregister(acc: string): void
  onPress(): void
}

export interface VoiceHotkey {
  /** Moves the shortcut to `acc` (null: off). Not ok leaves nothing registered. */
  set(acc: string | null): { ok: boolean }
  dispose(): void
}

/** The desk shortcut for voice: at most one accelerator, always one we registered ourselves, so we only ever unregister our own. */
export function createVoiceHotkey(d: VoiceHotkeyDeps): VoiceHotkey {
  let current: string | null = null
  const drop = (): void => {
    if (current === null) return
    const was = current
    current = null
    try {
      d.unregister(was)
    } catch {
      // nothing left to undo
    }
  }
  return {
    set(acc) {
      const want = acc === null ? null : cleanHotkey(acc)
      if (acc !== null && want === null) return { ok: false }
      if (want === current) return { ok: true }
      drop()
      if (want === null) return { ok: true }
      try {
        if (!d.register(want, d.onPress)) return { ok: false }
      } catch {
        return { ok: false }
      }
      current = want
      return { ok: true }
    },
    dispose: drop
  }
}
